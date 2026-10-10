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
const initializedPools = new Set()

const quoteIdentifier = (value) => {
    return "`" + String(value).replace(/`/g, "``") + "`"
}

// Automatically ensure required tables and columns exist
const ensureSchema = async (targetPool) => {
    const poolKey = targetPool.pool?.config?.database || 'pool'
    if (initializedPools.has(poolKey)) return
    try {
        // 1. Inventory Transactions table
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS inventory_transactions (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "item_id INT NOT NULL, " +
            "warehouse_id INT NOT NULL, " +
            "quantity DECIMAL(15,3) NOT NULL DEFAULT 0, " +
            "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"
        )
        
        // 2. Brands table & columns
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS brands (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "brand_name VARCHAR(255) NULL)"
        )

        // 3. Suppliers table & columns
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS suppliers (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "name VARCHAR(255) NULL)"
        )
        try {
            await targetPool.query("ALTER TABLE suppliers ADD COLUMN supplier_name VARCHAR(255) NULL")
        } catch (e) { if (e.errno !== 1060) {} }

        // 4. Items table & columns
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS items (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "name VARCHAR(255) NULL)"
        )
        const itemColumns = [
            "ADD COLUMN item_name VARCHAR(255) NULL",
            "ADD COLUMN item_code VARCHAR(100) NULL",
            "ADD COLUMN brand_id INT NULL",
            "ADD COLUMN minimum_stock DECIMAL(15,3) NOT NULL DEFAULT 0"
        ]
        for (const colQuery of itemColumns) {
            try {
                await targetPool.query(`ALTER TABLE items ${colQuery}`)
            } catch (e) { if (e.errno !== 1060) {} }
        }

        // 5. Warehouse table & columns
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS warehouse (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "name VARCHAR(255) NULL)"
        )
        try {
            await targetPool.query("ALTER TABLE warehouse ADD COLUMN warehouse_name VARCHAR(255) NULL")
        } catch (e) { if (e.errno !== 1060) {} }

        // 6. Shelves table & columns
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS shelves (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "name VARCHAR(255) NULL, " +
            "warehouse_id INT NULL)"
        )
        try {
            await targetPool.query("ALTER TABLE shelves ADD COLUMN shelf_code VARCHAR(100) NULL")
        } catch (e) { if (e.errno !== 1060) {} }

        // 7. Inventory table & columns
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS inventory (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "item_id INT NOT NULL, " +
            "quantity DECIMAL(15,3) NOT NULL DEFAULT 0)"
        )
        try {
            await targetPool.query("ALTER TABLE inventory ADD COLUMN warehouse_id INT NULL")
        } catch (e) { if (e.errno !== 1060) {} }

        // 8. Financial Journal table & columns
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS financial_journal (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "remaining_debt DECIMAL(15,2) NOT NULL DEFAULT 0, " +
            "remaining_receivables DECIMAL(15,2) NOT NULL DEFAULT 0)"
        )
        const journalColumns = [
            "ADD COLUMN order_date DATE NULL",
            "ADD COLUMN purchase_settlement_date DATE NULL",
            "ADD COLUMN purchase_due_date DATE NULL",
            "ADD COLUMN sale_settlement_date DATE NULL",
            "ADD COLUMN sale_due_date DATE NULL"
        ]
        for (const colQuery of journalColumns) {
            try {
                await targetPool.query(`ALTER TABLE financial_journal ${colQuery}`)
            } catch (e) { if (e.errno !== 1060) {} }
        }

        initializedPools.add(poolKey)
    } catch (err) {
        console.error("Table initialization note:", err.message)
    }
}

const getPool = (databaseName) => {
    if (!pools.has(databaseName)) {
        pools.set(databaseName, mysql.createPool({...poolOptions, database: databaseName}))
    }
    return pools.get(databaseName)
}

const getCurrentPool = async () => {
    const dbName = workspaceContext.getStore() || baseDatabase
    const p = getPool(dbName)
    await ensureSchema(p)
    return p
}

export const runWithWorkspaceDatabase = (databaseName, callback) =>
    workspaceContext.run(databaseName, callback)

export const runWithBaseDatabase = (callback) =>
    workspaceContext.run(baseDatabase, callback)

export const ensureWorkspaceDatabase = async (databaseName) => {
    const nameRegex = new RegExp("^[a-zA-Z0-9_]+$")
    if (!nameRegex.test(databaseName) || databaseName.length > 64) {
        throw new Error("Invalid workspace database name")
    }

    const [[sourceSchema]] = await basePool.query(
        "SELECT DEFAULT_CHARACTER_SET_NAME AS character_set, DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
        [baseDatabase]
    )
    if (!sourceSchema) throw new Error("Configured MySQL database does not exist")
    const characterSet = String(sourceSchema.character_set)
    const collation = String(sourceSchema.collation)
    
    if (!nameRegex.test(characterSet) || !nameRegex.test(collation)) {
        throw new Error("Invalid MySQL database character set")
    }

    await basePool.query(
        "CREATE DATABASE IF NOT EXISTS " + quoteIdentifier(databaseName) + " CHARACTER SET " + characterSet + " COLLATE " + collation
    )

    const workspacePool = getPool(databaseName)
    await ensureSchema(workspacePool)
}

const pool = {
    query: async (...args) => {
        const p = await getCurrentPool()
        return p.query(...args)
    },
    execute: async (...args) => {
        const p = await getCurrentPool()
        return p.execute(...args)
    },
    getConnection: async () => {
        const p = await getCurrentPool()
        return p.getConnection()
    },
    end: () => Promise.all(Array.from(pools.values()).map((workspacePool) => workspacePool.end()))
}

export default pool