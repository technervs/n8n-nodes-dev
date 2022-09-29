/* eslint-disable n8n-nodes-base/node-filename-against-convention */
import {
	INodeType,
	INodeTypeDescription
} from 'n8n-workflow';
import oracledb, {
	BindParameters,
	Connection,
	ConnectionAttributes,
	ExecuteOptions,
	Result
} from "oracledb";
import { FieldTypes } from "./constants";
import {
	DatasourcePlus,
	Operation,
	QueryJson, SqlQuery,
	Table
} from "../OracleSql/types/src";
import Sql from "./base/sql";
import {
	buildExternalTableId,
	convertSqlType,
	finaliseExternalTables,
	getSqlQuery,
	SqlClient
} from "./utils";

export class OracleSql implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Oracle Database',
		name: 'oracleSql',
		icon: 'file:mssql.svg',
		group: ['input'],
		version: 1,
		description: 'Get, add and update data in Oracle Database',
		defaults: {
			name: 'Oracle Database',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'oracleSqlApi',
				required: true,
				testedBy: 'oracleSqlConnectionTest',
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Execute Query',
						value: 'executeQuery',
						description: 'Execute an SQL query',
						action: 'Execute a SQL query',
					},
					{
						name: 'Insert',
						value: 'insert',
						description: 'Insert rows in database',
						action: 'Insert rows in database',
					},
					{
						name: 'Update',
						value: 'update',
						description: 'Update rows in database',
						action: 'Update rows in database',
					},
					{
						name: 'Delete',
						value: 'delete',
						description: 'Delete rows in database',
						action: 'Delete rows in database',
					},
				],
				default: 'insert',
			},

			// ----------------------------------
			//         executeQuery
			// ----------------------------------
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				typeOptions: {
					alwaysOpenEditWindow: true,
				},
				displayOptions: {
					show: {
						operation: ['executeQuery'],
					},
				},
				default: '',
				placeholder: 'SELECT * FROM dual WHERE rownum = 1',
				required: true,
				description: 'The SQL query to execute',
			},

			// ----------------------------------
			//         insert
			// ----------------------------------
			{
				displayName: 'Table',
				name: 'table',
				type: 'string',
				displayOptions: {
					show: {
						operation: ['insert'],
					},
				},
				default: '',
				required: true,
				description: 'Name of the table in which to insert data to',
			},
			{
				displayName: 'Columns',
				name: 'columns',
				type: 'string',
				displayOptions: {
					show: {
						operation: ['insert'],
					},
				},
				default: '',
				// eslint-disable-next-line n8n-nodes-base/node-param-placeholder-miscased-id
				placeholder: 'id,name,description',
				description:
					'Comma-separated list of the properties which should used as columns for the new rows',
			},

			// ----------------------------------
			//         update
			// ----------------------------------
			{
				displayName: 'Table',
				name: 'table',
				type: 'string',
				displayOptions: {
					show: {
						operation: ['update'],
					},
				},
				default: '',
				required: true,
				description: 'Name of the table in which to update data in',
			},
			{
				displayName: 'Update Key',
				name: 'updateKey',
				type: 'string',
				displayOptions: {
					show: {
						operation: ['update'],
					},
				},
				default: 'id',
				required: true,
				// eslint-disable-next-line n8n-nodes-base/node-param-description-miscased-id
				description:
					'Name of the property which decides which rows in the database should be updated. Normally that would be "id".',
			},
			{
				displayName: 'Columns',
				name: 'columns',
				type: 'string',
				displayOptions: {
					show: {
						operation: ['update'],
					},
				},
				default: '',
				placeholder: 'name,description',
				description:
					'Comma-separated list of the properties which should used as columns for rows to update',
			},

			// ----------------------------------
			//         delete
			// ----------------------------------
			{
				displayName: 'Table',
				name: 'table',
				type: 'string',
				displayOptions: {
					show: {
						operation: ['delete'],
					},
				},
				default: '',
				required: true,
				description: 'Name of the table in which to delete data',
			},
			{
				displayName: 'Delete Key',
				name: 'deleteKey',
				type: 'string',
				displayOptions: {
					show: {
						operation: ['delete'],
					},
				},
				default: 'id',
				required: true,
				// eslint-disable-next-line n8n-nodes-base/node-param-description-miscased-id
				description:
					'Name of the property which decides which rows in the database should be deleted. Normally that would be "id".',
			},
		],
	};
}

const UNSUPPORTED_TYPES = ["BLOB", "CLOB", "NCLOB"]

interface OracleConfig {
  host: string
  port: number
  database: string
  user: string
  password: string
}

/**
 * Raw query response
 */
interface ColumnsResponse {
  TABLE_NAME: string
  COLUMN_NAME: string
  DATA_TYPE: string
  DATA_DEFAULT: string | null
  COLUMN_ID: number
  CONSTRAINT_NAME: string | null
  CONSTRAINT_TYPE: string | null
  R_CONSTRAINT_NAME: string | null
  SEARCH_CONDITION: string | null
}

/**
 * An oracle constraint
 */
interface OracleConstraint {
  name: string
  type: string
  relatedConstraintName: string | null
  searchCondition: string | null
}

/**
 * An oracle column and it's related constraints
 */
interface OracleColumn {
  name: string
  type: string
  default: string | null
  id: number
  constraints: { [key: string]: OracleConstraint }
}

/**
 * An oracle table and it's related columns
 */
interface OracleTable {
  name: string
  columns: { [key: string]: OracleColumn }
}

const OracleContraintTypes = {
  PRIMARY: "P",
  NOT_NULL_OR_CHECK: "C",
  FOREIGN_KEY: "R",
  UNIQUE: "U",
}

class OracleIntegration extends Sql implements DatasourcePlus {
	[x: string]: any;
  private readonly config: OracleConfig
  private index: number = 1

  public tables: Record<string, Table> = {}
  public schemaErrors: Record<string, string> = {}

  private readonly COLUMNS_SQL = `
    SELECT
      tabs.table_name,
      cols.column_name,
      cols.data_type,
      cols.data_default,
      cols.column_id,
      cons.constraint_name,
      cons.constraint_type,
      cons.r_constraint_name,
      cons.search_condition
    FROM
      user_tables tabs
    JOIN
      user_tab_columns cols
      ON tabs.table_name = cols.table_name
    LEFT JOIN
      user_cons_columns col_cons
      ON cols.column_name = col_cons.column_name
      AND cols.table_name = col_cons.table_name
    LEFT JOIN
      user_constraints cons
      ON col_cons.constraint_name = cons.constraint_name
      AND cons.table_name = cols.table_name
    WHERE
      (cons.status = 'ENABLED'
        OR cons.status IS NULL)
  `
  constructor(config: OracleConfig) {
    super(SqlClient.ORACLE)
    this.config = config
  }

  getBindingIdentifier(): string {
    return `:${this.index++}`
  }

  getStringConcat(parts: string[]): string {
    return parts.join(" || ")
  }

  /**
   * Map the flat tabular columns and constraints data into a nested object
   */
  private mapColumns(result: Result<ColumnsResponse>): {
    [key: string]: OracleTable
  } {
    const oracleTables: { [key: string]: OracleTable } = {}

    if (result.rows) {
      result.rows.forEach(row => {
        const tableName = row.TABLE_NAME
        const columnName = row.COLUMN_NAME
        const dataType = row.DATA_TYPE
        const dataDefault = row.DATA_DEFAULT
        const columnId = row.COLUMN_ID
        const constraintName = row.CONSTRAINT_NAME
        const constraintType = row.CONSTRAINT_TYPE
        const relatedConstraintName = row.R_CONSTRAINT_NAME
        const searchCondition = row.SEARCH_CONDITION

        let table = oracleTables[tableName]
        if (!table) {
          table = {
            name: tableName,
            columns: {},
          }
          oracleTables[tableName] = table
        }

        let column = table.columns[columnName]
        if (!column) {
          column = {
            name: columnName,
            type: dataType,
            default: dataDefault,
            id: columnId,
            constraints: {},
          }
          table.columns[columnName] = column
        }

        if (constraintName && constraintType) {
          let constraint = column.constraints[constraintName]
          if (!constraint) {
            constraint = {
              name: constraintName,
              type: constraintType,
              relatedConstraintName: relatedConstraintName,
              searchCondition: searchCondition,
            }
          }
          column.constraints[constraintName] = constraint
        }
      })
    }

    return oracleTables
  }

  private static isSupportedColumn(column: OracleColumn) {
    return !UNSUPPORTED_TYPES.includes(column.type)
  }

  private static isAutoColumn(column: OracleColumn) {
    return !!(
      column.default && column.default.toLowerCase().includes("nextval")
    )
  }

  /**
   * No native boolean in oracle. Best we can do is to check if a manual 1 or 0 number constraint has been set up
   * This matches the default behaviour for generating DDL used in knex.
   */
  private isBooleanType(column: OracleColumn): boolean {
    return (
      column.type.toLowerCase() === "number" &&
      Object.values(column.constraints).filter(c => {
        if (
          c.type === OracleContraintTypes.NOT_NULL_OR_CHECK &&
          c.searchCondition
        ) {
          const condition = c.searchCondition
            .replace(/\s/g, "") // remove spaces
            .replace(/[']+/g, "") // remove quotes
          if (condition.includes("in(0,1)") || condition.includes("in(1,0)")) {
            return true
          }
        }
        return false
      }).length > 0
    )
  }

  private internalConvertType(column: OracleColumn): { type: string } {
    if (this.isBooleanType(column)) {
      return { type: FieldTypes.BOOLEAN }
    }

    return convertSqlType(column.type)
  }

  /**
   * Fetches the tables from the oracle table and assigns them to the datasource.
   * @param {*} datasourceId - datasourceId to fetch
   * @param entities - the tables that are to be built
   */
  async buildSchema(datasourceId: string, entities: Record<string, Table>) {
    const columnsResponse = await this.internalQuery<ColumnsResponse>({
      sql: this.COLUMNS_SQL,
    })
    const oracleTables = this.mapColumns(columnsResponse)

    const tables: { [key: string]: Table } = {}

    // iterate each table
    Object.values(oracleTables).forEach(oracleTable => {
      let table = tables[oracleTable.name]
      if (!table) {
        table = {
          _id: buildExternalTableId(datasourceId, oracleTable.name),
          primary: [],
          name: oracleTable.name,
          schema: {},
        }
        tables[oracleTable.name] = table
      }

      // iterate each column on the table
      Object.values(oracleTable.columns)
        // remove columns that we can't read / save
        .filter(oracleColumn =>
          OracleIntegration.isSupportedColumn(oracleColumn)
        )
        // match the order of the columns in the db
        .sort((c1, c2) => c1.id - c2.id)
        .forEach(oracleColumn => {
          const columnName = oracleColumn.name
          let fieldSchema = table.schema[columnName]
          if (!fieldSchema) {
            fieldSchema = {
              autocolumn: OracleIntegration.isAutoColumn(oracleColumn),
              name: columnName,
              ...this.internalConvertType(oracleColumn),
            }
            table.schema[columnName] = fieldSchema
          }

          // iterate each constraint on the column
          Object.values(oracleColumn.constraints).forEach(oracleConstraint => {
            if (oracleConstraint.type === OracleContraintTypes.PRIMARY) {
              table.primary!.push(columnName)
            }
          })
        })
    })

    const final = finaliseExternalTables(tables, entities)
    this.tables = final.tables
    this.schemaErrors = final.errors
  }

  private async internalQuery<T>(query: SqlQuery): Promise<Result<T>> {
    let connection
    try {
      this.index = 1
      connection = await this.getConnection()

      const options: ExecuteOptions = { autoCommit: true }
      const bindings: BindParameters = query.bindings || []

      return await connection.execute<T>(query.sql, bindings, options)
    } finally {
      if (connection) {
        try {
          await connection.close()
        } catch (err) {
          console.error(err)
        }
      }
    }
  }

  private getConnection = async (): Promise<Connection> => {
    //connectString : "(DESCRIPTION =(ADDRESS = (PROTOCOL = TCP)(HOST = localhost)(PORT = 1521))(CONNECT_DATA =(SID= ORCL)))"
    const connectString = `${this.config.host}:${this.config.port || 1521}/${
      this.config.database
    }`
    const attributes: ConnectionAttributes = {
      user: this.config.user,
      password: this.config.password,
      connectString,
    }
    return oracledb.getConnection(attributes)
  }

  async create(query: SqlQuery | string): Promise<any[]> {
    const response = await this.internalQuery<any>(getSqlQuery(query))
    return response.rows && response.rows.length
      ? response.rows
      : [{ created: true }]
  }

  async read(query: SqlQuery | string): Promise<any[]> {
    const response = await this.internalQuery<any>(getSqlQuery(query))
    return response.rows ? response.rows : []
  }

  async update(query: SqlQuery | string): Promise<any[]> {
    const response = await this.internalQuery(getSqlQuery(query))
    return response.rows && response.rows.length
      ? response.rows
      : [{ updated: true }]
  }

  async delete(query: SqlQuery | string): Promise<any[]> {
    const response = await this.internalQuery(getSqlQuery(query))
    return response.rows && response.rows.length
      ? response.rows
      : [{ deleted: true }]
  }

  async query(json: QueryJson) {
    const operation = this._operation(json)
    const input = this._query(json, { disableReturning: true })
    if (Array.isArray(input)) {
      const responses = []
      for (let query of input) {
        responses.push(await this.internalQuery(query))
      }
      return responses
    } else {
      // read the row to be deleted up front for the return
      let deletedRows
      if (operation === Operation.DELETE) {
        const queryFn = (query: any) => this.internalQuery(query)
        deletedRows = await this.getReturningRow(queryFn, json)
      }

      // run the query
      const response = await this.internalQuery(input)

      // get the results or return the created / updated / deleted row
      if (deletedRows?.rows?.length) {
        return deletedRows.rows
      } else if (response.rows?.length) {
        return response.rows
      } else {
        // get the last row that was updated
        if (
          response.lastRowid &&
          json.endpoint?.entityId &&
          operation !== Operation.DELETE
        ) {
          const lastRow = await this.internalQuery({
            sql: `SELECT * FROM \"${json.endpoint.entityId}\" WHERE ROWID = '${response.lastRowid}'`,
          })
          return lastRow.rows
        } else {
          return [{ [operation.toLowerCase()]: true }]
        }
      }
    }
  }
}

export default {
  schema: OracleSql,
  integration: OracleIntegration,
}
