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

const quoteIdentifier = (value) => {
    return "`" + String(value).replace(/`/g, "``") + "`"
}

// Automatically ensure required tables and columns exist on every pool connection
const ensureSchema = async (targetPool) => {
    try {
        // 1. Inventory Transactions table & columns
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS inventory_transactions (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "item_id INT NOT NULL, " +
            "warehouse_id INT NOT NULL, " +
            "quantity DECIMAL(15,3) NOT NULL DEFAULT 0, " +
            "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"
        )
        const txnColumns = [
            "ADD COLUMN transaction_type VARCHAR(50) NULL",
            "ADD COLUMN shelf_id INT NULL"
        ]
        for (const colQuery of txnColumns) {
            try {
                await targetPool.query(`ALTER TABLE inventory_transactions ${colQuery}`)
            } catch (e) { if (e.errno !== 1060) {} }
        }
        
        // 2. Stock Transfers table & columns
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS stock_transfers (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "status VARCHAR(50) NOT NULL DEFAULT 'PENDING')"
        )
        const transferColumns = [
            "ADD COLUMN from_warehouse_id INT NULL",
            "ADD COLUMN to_warehouse_id INT NULL",
            "ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
        ]
        for (const colQuery of transferColumns) {
            try {
                await targetPool.query(`ALTER TABLE stock_transfers ${colQuery}`)
            } catch (e) { if (e.errno !== 1060) {} }
        }

        // 3. Purchase Orders table & columns
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS purchase_orders (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "status VARCHAR(50) NOT NULL DEFAULT 'PENDING')"
        )
        const poColumns = [
            "ADD COLUMN supplier_id INT NULL",
            "ADD COLUMN po_number VARCHAR(100) NULL",
            "ADD COLUMN po_date DATE NULL",
            "ADD COLUMN status VARCHAR(50) NOT NULL DEFAULT 'PENDING'",
            "ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
        ]
        for (const colQuery of poColumns) {
            try {
                await targetPool.query(`ALTER TABLE purchase_orders ${colQuery}`)
            } catch (e) { if (e.errno !== 1060) {} }
        }

        // 4. Purchase Order Items table
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS purchase_order_items (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "purchase_order_id INT NOT NULL, " +
            "quantity DECIMAL(15,3) NOT NULL DEFAULT 0, " +
            "unit_cost DECIMAL(15,4) NOT NULL DEFAULT 0)"
        )

        // 5. Brands table
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS brands (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "brand_name VARCHAR(255) NULL)"
        )

        // 6. Units table
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS units (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "unit_name VARCHAR(100) NULL)"
        )

        // 7. Item Costs table
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS item_costs (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "item_id INT NOT NULL, " +
            "avg_cost DECIMAL(15,4) NOT NULL DEFAULT 0, " +
            "markup_pct DECIMAL(5,2) NOT NULL DEFAULT 30)"
        )

        // 8. Inventory Cost Layers table (FIFO) & columns
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS inventory_cost_layers (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "item_id INT NOT NULL, " +
            "remaining_quantity DECIMAL(15,3) NOT NULL DEFAULT 0, " +
            "unit_cost DECIMAL(15,4) NOT NULL DEFAULT 0)"
        )
        const costLayerColumns = [
            "ADD COLUMN warehouse_id INT NULL",
            "ADD COLUMN shelf_id INT NULL",
            "ADD COLUMN received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
        ]
        for (const colQuery of costLayerColumns) {
            try {
                await targetPool.query(`ALTER TABLE inventory_cost_layers ${colQuery}`)
            } catch (e) { if (e.errno !== 1060) {} }
        }

        // 9. Suppliers table & columns
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS suppliers (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "name VARCHAR(255) NULL)"
        )
        try {
            await targetPool.query("ALTER TABLE suppliers ADD COLUMN supplier_name VARCHAR(255) NULL")
        } catch (e) { if (e.errno !== 1060) {} }

        // 10. Items table & columns
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

        // 11. Warehouse table & columns
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS warehouse (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "name VARCHAR(255) NULL)"
        )
        try {
            await targetPool.query("ALTER TABLE warehouse ADD COLUMN warehouse_name VARCHAR(255) NULL")
        } catch (e) { if (e.errno !== 1060) {} }

        // 12. Shelves table & columns
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS shelves (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "name VARCHAR(255) NULL, " +
            "warehouse_id INT NULL)"
        )
        try {
            await targetPool.query("ALTER TABLE shelves ADD COLUMN shelf_code VARCHAR(100) NULL")
        } catch (e) { if (e.errno !== 1060) {} }

        // 13. Inventory table & columns
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS inventory (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "item_id INT NOT NULL, " +
            "quantity DECIMAL(15,3) NOT NULL DEFAULT 0)"
        )
        const invColumns = [
            "ADD COLUMN warehouse_id INT NULL",
            "ADD COLUMN shelf_id INT NULL"
        ]
        for (const colQuery of invColumns) {
            try {
                await targetPool.query(`ALTER TABLE inventory ${colQuery}`)
            } catch (e) { if (e.errno !== 1060) {} }
        }

        // 14. Financial Journal table & columns
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS financial_journal (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "remaining_debt DECIMAL(15,2) NOT NULL DEFAULT 0, " +
            "remaining_receivables DECIMAL(15,2) NOT NULL DEFAULT 0)"
        )
        const journalColumns = [
            "ADD COLUMN number VARCHAR(100) NULL",
            "ADD COLUMN type VARCHAR(50) NULL",
            "ADD COLUMN name VARCHAR(255) NULL",
            "ADD COLUMN order_date DATE NULL",
            "ADD COLUMN quantity_kg DECIMAL(15,3) NOT NULL DEFAULT 0",
            "ADD COLUMN quantity_in_kg DECIMAL(15,3) NOT NULL DEFAULT 0",
            "ADD COLUMN quantity_out_kg DECIMAL(15,3) NOT NULL DEFAULT 0",
            "ADD COLUMN stock_remaining DECIMAL(15,3) NOT NULL DEFAULT 0",
            "ADD COLUMN brand VARCHAR(255) NULL",
            "ADD COLUMN serial_number VARCHAR(255) NULL",
            "ADD COLUMN adjustment DECIMAL(15,2) NOT NULL DEFAULT 0",
            "ADD COLUMN purchase_price_per_unit DECIMAL(15,4) NOT NULL DEFAULT 0",
            "ADD COLUMN total_purchase_price DECIMAL(15,2) NOT NULL DEFAULT 0",
            "ADD COLUMN purchase_amount_paid DECIMAL(15,2) NOT NULL DEFAULT 0",
            "ADD COLUMN purchase_settlement_date DATE NULL",
            "ADD COLUMN purchase_due_date DATE NULL",
            "ADD COLUMN selling_price_per_unit DECIMAL(15,4) NOT NULL DEFAULT 0",
            "ADD COLUMN total_selling_price DECIMAL(15,2) NOT NULL DEFAULT 0",
            "ADD COLUMN sale_amount_received DECIMAL(15,2) NOT NULL DEFAULT 0",
            "ADD COLUMN sale_settlement_date DATE NULL",
            "ADD COLUMN sale_due_date DATE NULL",
            "ADD COLUMN payment_status VARCHAR(50) NULL",
            "ADD COLUMN paid_status VARCHAR(50) NULL",
            "ADD COLUMN commission DECIMAL(15,2) NOT NULL DEFAULT 0",
            "ADD COLUMN commission_paid_status VARCHAR(50) NULL",
            "ADD COLUMN paid_commission DECIMAL(15,2) NOT NULL DEFAULT 0",
            "ADD COLUMN profit DECIMAL(15,2) NOT NULL DEFAULT 0",
            "ADD COLUMN paid_to VARCHAR(255) NULL",
            "ADD COLUMN notes VARCHAR(255) NULL",
            "ADD COLUMN import_reference VARCHAR(255) NULL"
        ]
        for (const colQuery of journalColumns) {
            try {
                await targetPool.query(`ALTER TABLE financial_journal ${colQuery}`)
            } catch (e) { if (e.errno !== 1060) {} }
        }

        // 15. Financial Journal Import Summaries table
        await targetPool.query(
            "CREATE TABLE IF NOT EXISTS financial_journal_import_summaries (" +
            "id INT AUTO_INCREMENT PRIMARY KEY, " +
            "source_id VARCHAR(100) NULL, " +
            "as_of_date DATE NULL, " +
            "row_count INT NOT NULL DEFAULT 0, " +
            "totals TEXT NULL, " +
            "balances TEXT NULL)"
        )
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