import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
import {AsyncLocalStorage} from 'node:async_hooks'

dotenv.config()
const baseDatabase = process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE
const mysqlPort = Number(process.env.MYSQLPORT || process.env.MYSQL_PORT || 3306)
const poolOptions = {
    host : process.env.MYSQLHOST || process.env.MYSQL_HOST,
    user : process.env.MYSQLUSER || process.env.MYSQL_USERNAME,
    password : process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD,
    port: mysqlPort,
    waitForConnections : true,
    connectionLimit : 10,
    queueLimit : 0,
    connectTimeout: 10000
}
const basePool = mysql.createPool({...poolOptions, database: baseDatabase})
const pools = new Map([[baseDatabase, basePool]])
const workspaceContext = new AsyncLocalStorage()

const quoteIdentifier = (value) => `\`${String(value).replace(/`/g, '``')}\``

const getPool = (databaseName) => {
    if (!pools.has(databaseName)) {
        pools.set(databaseName, mysql.createPool({...poolOptions, database: databaseName}))
    }
    return pools.get(databaseName)
}

export const runWithWorkspaceDatabase = (databaseName, callback) =>
    workspaceContext.run(databaseName, callback)

export const runWithBaseDatabase = (callback) =>
    workspaceContext.run(baseDatabase, callback)

export const ensureWorkspaceDatabase = async (databaseName) => {
    if (!/^[a-zA-Z0-9_]+$/.test(databaseName) || databaseName.length > 64) {
        throw new Error('Invalid workspace database name')
    }

    const [[sourceSchema]] = await basePool.query(`
        SELECT DEFAULT_CHARACTER_SET_NAME AS character_set,
               DEFAULT_COLLATION_NAME AS collation
        FROM information_schema.SCHEMATA
        WHERE SCHEMA_NAME = ?
    `, [baseDatabase])
    if (!sourceSchema) throw new Error('Configured MySQL database does not exist')
    const characterSet = String(sourceSchema.character_set)
    const collation = String(sourceSchema.collation)
    if (!/^[a-zA-Z0-9_]+$/.test(characterSet) || !/^[a-zA-Z0-9_]+$/.test(collation)) {
        throw new Error('Invalid MySQL database character set')
    }

    await basePool.query(
        `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(databaseName)} CHARACTER SET ${characterSet} COLLATE${collation}`
    )

    const [sourceTables] = await basePool.query(`
        SELECT TABLE_NAME AS table_name
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
          AND TABLE_NAME NOT IN (?, ?, ?, ?, ?)
        ORDER BY TABLE_NAME
    `, [baseDatabase, 'app_users', 'app_sessions', 'app_workspace', 'app_user_workspaces', 'app_workspace_invites'])
    const [targetTables] = await basePool.query(
        'SELECT TABLE_NAME AS table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
        [databaseName]
    )
    const existingTables = new Set(targetTables.map((row) => row.table_name))
    const tableNames = new Set(sourceTables.map((row) => row.table_name))
    const dependencies = new Map([...tableNames].map((tableName) => [tableName, new Set()]))
    const [foreignKeys] = await basePool.query(`
        SELECT TABLE_NAME AS table_name, REFERENCED_TABLE_NAME AS referenced_table_name
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE CONSTRAINT_SCHEMA = ? AND REFERENCED_TABLE_SCHEMA = ?
          AND REFERENCED_TABLE_NAME IS NOT NULL
    `, [baseDatabase, baseDatabase])
    for (const key of foreignKeys) {
        if (key.table_name !== key.referenced_table_name && tableNames.has(key.table_name) && tableNames.has(key.referenced_table_name)) {
            dependencies.get(key.table_name).add(key.referenced_table_name)
        }
    }

    const pending = new Set([...tableNames].filter((tableName) => !existingTables.has(tableName)))
    while (pending.size > 0) {
        const ready = [...pending].filter((tableName) =>
            [...dependencies.get(tableName)].every((dependency) => !pending.has(dependency))
        )
        if (ready.length === 0) throw new Error('Could not order workspace tables by foreign-key dependencies')

        for (const tableName of ready) {
            const [[definition]] = await basePool.query(
                `SHOW CREATE TABLE ${quoteIdentifier(baseDatabase)}.${quoteIdentifier(tableName)}`
            )
            const createStatement = Object.values(definition)[1]
                .replace(/^CREATE TABLE `[^`]+`/, `CREATE TABLE ${quoteIdentifier(databaseName)}.${quoteIdentifier(tableName)}`)
                .replace(/REFERENCES\s+(?:`[^`]+`\.)?`([^`]+)`/g, (_, referencedTable) =>
                    `REFERENCES ${quoteIdentifier(databaseName)}.${quoteIdentifier(referencedTable)}`
                )
                .replace(/\sAUTO_INCREMENT=\d+/i, '')
            await basePool.query(createStatement)
            pending.delete(tableName)
        }
    }
}

const currentPool = () => getPool(workspaceContext.getStore() || baseDatabase)

const pool = {
    query: (...args) => currentPool().query(...args),
    execute: (...args) => currentPool().execute(...args),
    getConnection: () => currentPool().getConnection(),
    end: () => Promise.all([...pools.values()].map((workspacePool) => workspacePool.end()))
}

// Safely initialize the base table and columns on startup
try {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS financial_journal (
            id INT AUTO_INCREMENT PRIMARY KEY,
            purchase_settlement_date DATE NULL,
            purchase_due_date DATE NULL
        )
    `);
    
    try {
        await pool.query(`
            ALTER TABLE financial_journal 
            ADD COLUMN purchase_due_date DATE NULL 
            AFTER purchase_settlement_date
        `);
    } catch (alterErr) {
        // Ignore error if column already exists (Error code 1060)
        if (alterErr.errno !== 1060) {
            console.error("Note on financial_journal migration:", alterErr.message);
        }
    }
} catch (err) {
    console.error("Database startup initialization error:", err);
}

export default pool