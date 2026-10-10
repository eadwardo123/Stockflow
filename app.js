import express from 'express'
import helmet from 'helmet'
import {rateLimit} from 'express-rate-limit'
import {engine} from 'express-handlebars'
import session from 'express-session'
import MySQLStoreFactory from 'express-mysql-session'
import PDFDocument from 'pdfkit'
import {mkdir, readFile, readdir, rename, unlink, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {promisify} from 'node:util'
import {createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual} from 'node:crypto'
import {gunzipSync, gzipSync} from 'node:zlib'
import pool, {ensureWorkspaceDatabase, runWithBaseDatabase, runWithWorkspaceDatabase} from './db.js'
import inventoryRouter from './inventory.js';
import http from 'http';
import { Server } from 'socket.io';

const app = express()
app.use((req, res, next) => {
  req.io = io;
  next();
});
const server = http.createServer(app);
const io = new Server(server);
const port = Number(process.env.PORT) || 3003
const production = process.env.NODE_ENV === 'production'
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS || 0)

if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0) {
    throw new Error('TRUST_PROXY_HOPS must be a non-negative integer')
}
if (trustProxyHops > 0) app.set('trust proxy', trustProxyHops)
app.use(helmet({contentSecurityPolicy: false}))
const mysqlPort = Number(process.env.MYSQL_PORT || process.env.MYSQL_POST) || 3306
if (production && !process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET must be set in production')
}
if (!process.env.SESSION_SECRET) {
    console.warn('SESSION_SECRET is unset; active sessions will expire when the server restarts.')
}
const sessionSecret = process.env.SESSION_SECRET || (production ? null : randomBytes(32).toString('hex'))
const MySQLStore = MySQLStoreFactory(session)
const sessionLifetime = 24 * 60 * 60 * 1000
let workspaceOwnerId = null

const sessionStore = new MySQLStore({
    host: process.env.MYSQL_HOST,
    port: mysqlPort,
    user: process.env.MYSQL_USERNAME,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    expiration: sessionLifetime,
    schema: {tableName: 'app_sessions'}
})
const scrypt = promisify(scryptCallback)

const workspacePreferenceChecks = new Map()
const workspaceLocale = (preferences = {}) => preferences.language_code === 'id' ? 'id-ID' : 'en-US'
const workspaceCurrency = (preferences = {}) => /^[A-Z]{3}$/.test(preferences.currency_code || '')
    ? preferences.currency_code
    : 'IDR'
const formatWorkspaceCurrency = (value, preferences = {}, compact = false) => {
    const numeric = Number(value ?? 0)
    if (!Number.isFinite(numeric)) return '0'
    return new Intl.NumberFormat(workspaceLocale(preferences), {
        style: 'currency',
        currency: workspaceCurrency(preferences),
        notation: compact ? 'compact' : 'standard',
        minimumFractionDigits: 0,
        maximumFractionDigits: compact ? 1 : 4
    }).format(numeric)
}

const interfaceTranslations = {
    id: {
        'Overview': 'Ringkasan',
        'Costing methods': 'Metode biaya',
        'Inventory': 'Inventaris',
        'Procurement': 'Pengadaan',
        'Setup': 'Pengaturan',
        'Information': 'Informasi',
        'Dashboard': 'Dasbor',
        'Financial journal': 'Jurnal keuangan',
        'WAC report': 'Laporan WAC',
        'FIFO report': 'Laporan FIFO',
        'Stock transactions': 'Transaksi stok',
        'Transfers': 'Transfer',
        'Purchase and Pre-orders': 'Pembelian dan Pre-order',
        'Master data': 'Data utama',
        'Team access': 'Akses tim',
        'Audit log': 'Log audit',
        'Backups': 'Cadangan',
        'About StockFlow': 'Tentang StockFlow',
        'Workspace settings': 'Pengaturan ruang kerja',
        'Beginner tutorial': 'Panduan pemula',
        'Manage master data': 'Kelola data utama',
        'Enable alerts': 'Aktifkan notifikasi',
        'Sign out': 'Keluar',
        'New transaction': 'Transaksi baru',
        'Workspace live': 'Ruang kerja aktif',
        'Review in Financial Journal': 'Tinjau di Jurnal Keuangan',
        'Overdue': 'Terlambat',
        'Due today': 'Jatuh tempo hari ini',
        'Pay': 'Bayar',
        'Collect': 'Tagih',
        'Operations Dashboard': 'Dasbor Operasional',
        'Needs attention': 'Perlu ditindaklanjuti',
        'Low stock items': 'Stok menipis',
        'Payments due': 'Pembayaran jatuh tempo',
        'Pending purchase orders': 'Pesanan pembelian tertunda',
        'Pending pre-orders': 'Pre-order tertunda',
        'Recent stock movements': 'Pergerakan stok terbaru',
        'Set up your workspace': 'Siapkan ruang kerja',
        'Inventory control': 'Kontrol inventaris',
        'Live view of stock health, purchasing activity, and recent movements.': 'Ringkasan kondisi stok, pembelian, dan pergerakan terbaru.',
        'Record movement': 'Catat pergerakan',
        'Manage inventory with confidence.': 'Kelola inventaris dengan yakin.',
        'Keep warehouse stock accurate, review supplier activity, and understand the financial impact of every movement from one operational dashboard.': 'Pantau stok gudang, aktivitas pemasok, dan dampak keuangan setiap pergerakan dari satu dasbor.',
        'Create purchase order': 'Buat pesanan pembelian',
        'Purchase orders': 'Pesanan pembelian',
        'Invoices': 'Faktur',
        'Costing reports': 'Laporan biaya',
        'Items tracked': 'Barang terdata',
        'Current product catalog': 'Katalog barang saat ini',
        'Stock on hand': 'Stok tersedia',
        'Units across all warehouses': 'Jumlah di semua gudang',
        'Workflow status': 'Status alur kerja',
        'Pending transfers': 'Transfer tertunda',
        'Ready': 'Siap',
        'Add stock data to begin tracking operations': 'Tambahkan data stok untuk mulai memantau operasional',
        'Progress is saved as you add real business records.': 'Progres tersimpan saat Anda menambahkan data bisnis.',
        'Completed': 'Selesai',
        'Still needed': 'Belum selesai',
        'Open': 'Buka',
        'Review': 'Tinjau',
        'Ask an admin': 'Hubungi admin',
        'Hide checklist': 'Sembunyikan daftar',
        'Setup checklist hidden': 'Daftar persiapan disembunyikan',
        'Your progress is saved. Reopen it whenever you are ready.': 'Progres tersimpan. Buka kembali kapan saja.',
        'Show checklist': 'Tampilkan daftar',
        'Open an item to review and resolve it.': 'Buka bagian untuk memeriksa dan menyelesaikan masalah.',
        'At or below minimum stock': 'Mencapai atau di bawah batas stok minimum',
        'due or overdue': 'jatuh tempo atau terlambat',
        'Awaiting receipt': 'Menunggu penerimaan',
        'Awaiting fulfillment': 'Menunggu pemenuhan',
        'Total items': 'Total barang',
        'Total stock': 'Total stok',
        'Pending orders': 'Pesanan tertunda',
        'View all': 'Lihat semua',
        'Audit trail — latest 10 transactions across all warehouses': 'Riwayat 10 transaksi terbaru dari semua gudang',
        'No stock movements have been recorded yet.': 'Belum ada pergerakan stok yang tercatat.',
        'Create a warehouse and shelf': 'Buat gudang dan rak',
        'Add your first item': 'Tambahkan barang pertama',
        'Add a supplier': 'Tambahkan pemasok',
        'Receive your first stock': 'Terima stok pertama',
        'Start beginner tutorial': 'Mulai panduan pemula',
        'Save settings': 'Simpan pengaturan',
        'Buy stock from suppliers, receive it into your warehouse, and track customer demand before stock arrives.': 'Beli stok dari pemasok, terima ke gudang, dan pantau permintaan pelanggan sebelum stok tersedia.',
        'Receive pending order': 'Terima pesanan tertunda',
        'Order history': 'Riwayat pesanan',
        'All purchase orders across all suppliers': 'Semua pesanan pembelian dari seluruh pemasok',
        'Supplier': 'Pemasok',
        'Order date': 'Tanggal pesanan',
        'Item': 'Barang',
        'Quantity': 'Jumlah',
        'Unit cost': 'Biaya per unit',
        'Production date': 'Tanggal produksi',
        'Place order': 'Buat pesanan',
        'Purchase order': 'Pesanan pembelian',
        'Destination warehouse': 'Gudang tujuan',
        'Shelf': 'Rak',
        'First shelf': 'Rak pertama',
        'Supplier payment due date': 'Tanggal jatuh tempo pembayaran pemasok',
        'Receive stock': 'Terima stok',
        'PO number': 'Nomor pesanan',
        'Date': 'Tanggal',
        'Total': 'Total',
        'Status': 'Status',
        'No purchase orders recorded yet.': 'Belum ada pesanan pembelian.',
        'Customer pre-orders': 'Pre-order pelanggan',
        'Record demand and expected delivery before stock arrives': 'Catat permintaan dan perkiraan pengiriman sebelum stok tiba',
        'Create pre-order': 'Buat pre-order',
        'Customer': 'Pelanggan',
        'Unit price': 'Harga per unit',
        'Expected delivery': 'Perkiraan pengiriman',
        'Expected': 'Perkiraan',
        'Action': 'Tindakan',
        'Choose item': 'Pilih barang',
        'Optional notes': 'Catatan opsional',
        'Customer reservations and expected delivery timing': 'Reservasi pelanggan dan perkiraan waktu pengiriman',
        'Awaiting fulfillment': 'Menunggu pemenuhan',
        'Completed orders': 'Pesanan selesai',
        'Closed reservations': 'Reservasi ditutup',
        'No action': 'Tidak ada tindakan',
        'Save pre-order': 'Simpan pre-order',
        'Pre-order overview': 'Ringkasan pre-order',
        'Pending': 'Tertunda',
        'Fulfilled': 'Dipenuhi',
        'Cancelled': 'Dibatalkan',
        'Pre-order list': 'Daftar pre-order',
        'Mark fulfilled': 'Tandai dipenuhi',
        'No pre-orders recorded yet.': 'Belum ada pre-order.',
        'Sell stock': 'Jual stok',
        'Buy stock': 'Beli stok',
        'Customer return': 'Retur pelanggan',
        'Record customer sale': 'Catat penjualan pelanggan',
        'Selling price / unit': 'Harga jual per unit',
        'Amount paid / received': 'Jumlah dibayar / diterima',
        'Warehouse': 'Gudang',
        'Notes': 'Catatan',
        'Record payment or collection': 'Catat pembayaran atau penagihan',
        'Settlement date': 'Tanggal pelunasan',
        'Update status': 'Perbarui status',
        'Finance': 'Keuangan',
        'Spreadsheet-style financial ledger linked to purchases, sales, settlements, and profit. Currency:': 'Jurnal keuangan yang menghubungkan pembelian, penjualan, pelunasan, dan laba. Mata uang:',
        'Download CSV': 'Unduh CSV',
        'Add journal entry': 'Tambah entri jurnal',
        'Print journal': 'Cetak jurnal',
        'Journal entries': 'Entri jurnal',
        'Current stock (kg)': 'Stok saat ini (kg)',
        'Total purchases': 'Total pembelian',
        'Total sales': 'Total penjualan',
        'Total profit': 'Total laba',
        'New journal entry': 'Entri jurnal baru',
        'Choose type…': 'Pilih jenis…',
        'Purchase': 'Pembelian',
        'Sale': 'Penjualan',
        'Choose brand…': 'Pilih merek…',
        'Not linked to stock': 'Tidak terhubung ke stok',
        'Payment status': 'Status pembayaran',
        'Choose status…': 'Pilih status…',
        'Save journal entry': 'Simpan entri jurnal',
        'Record an amount against an unpaid purchase or sale. The remaining debt/receivable and both status columns update together.': 'Catat pembayaran untuk pembelian atau penjualan yang belum lunas. Sisa utang/piutang dan status akan diperbarui.',
        'Journal entry': 'Entri jurnal',
        'Choose an open balance…': 'Pilih saldo yang belum lunas…',
        'Select an entry to see its balance.': 'Pilih entri untuk melihat saldonya.',
        'There are no outstanding purchase or sale balances to settle.': 'Tidak ada saldo pembelian atau penjualan yang perlu dilunasi.',
        'Search journal…': 'Cari jurnal…',
        'No journal entries yet.': 'Belum ada entri jurnal.',
        'order_date': 'Tanggal pesanan',
        'number': 'Nomor referensi',
        'type': 'Jenis',
        'name': 'Nama',
        'brand': 'Merek',
        'serial_number': 'Nomor seri',
        'costing method': 'Metode biaya',
        'purchase_due_date': 'Tanggal jatuh tempo pembelian',
        'sale_due_date': 'Tanggal jatuh tempo penjualan',
        'payment_status': 'Status pembayaran',
        'paid_status': 'Status pelunasan',
        'No stock movements have been recorded yet.': 'Belum ada pergerakan stok yang tercatat.'
    }
}

const ensureWorkspacePreferences = async () => {
    const [[database]] = await pool.query('SELECT DATABASE() AS databaseName')
    const databaseName = database.databaseName
    let check = workspacePreferenceChecks.get(databaseName)
    if (!check) {
        check = (async () => {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS workspace_preferences (
                    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
                    currency_code CHAR(3) NOT NULL DEFAULT 'IDR',
                    language_code ENUM('en', 'id') NOT NULL DEFAULT 'en',
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `)
            await pool.query("INSERT IGNORE INTO workspace_preferences (id, currency_code, language_code) VALUES (1, 'IDR', 'en')")
        })()
        workspacePreferenceChecks.set(databaseName, check)
        check.catch(() => workspacePreferenceChecks.delete(databaseName))
    }
    await check
}

app.engine('handlebars', engine({
    partialsDir: './views/partials',
    helpers: {
        eq: (a, b) => a === b,
        translate: (key, options) => {
            const language = options?.data?.root?.workspacePreferences?.language_code || 'en'
            return interfaceTranslations[language]?.[String(key)] || key
        },
        json: (value) => JSON.stringify(value).replace(/</g, '\\u003c'),
        number: (value, maxFractionDigits = 4, options) => {
            const numeric = Number(value ?? 0)
            if (!Number.isFinite(numeric)) return '0'
            const preferences = options?.data?.root?.workspacePreferences || {}
            return numeric.toLocaleString(workspaceLocale(preferences), {
                minimumFractionDigits: 0,
                maximumFractionDigits: Number(maxFractionDigits) || 4
            })
        },
        rupiah: (value, options) => value === null || value === undefined || value === ''
            ? '—'
            : formatWorkspaceCurrency(value, options?.data?.root?.workspacePreferences || {}, true),
        rupiahExact: (value, options) => value === null || value === undefined || value === ''
            ? '—'
            : formatWorkspaceCurrency(value, options?.data?.root?.workspacePreferences || {})
    }
}))
app.set('view engine', 'handlebars')
app.set('views', './views')

app.use(express.json({limit: '1mb'}))
app.use(express.urlencoded({
    extended: true,
    limit: '1mb'
}))

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.use(session({
    name: 'stockflow.sid',
    secret: sessionSecret || 'SESSION_SECRET must be set in production',
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: production,
        maxAge: sessionLifetime
    }
}))

app.use((req, res, next) => {
    const flash = req.session.flash
    delete req.session.flash
    res.locals.flash = flash || null
    next()
})

app.use(async (req, res, next) => {
    if (['/login', '/register', '/logout'].includes(req.path)
        || req.path.startsWith('/invite/')
        || req.path.startsWith('/assets/')) return next()
    if (!req.session.user) {
        if (req.path.startsWith('/api/')) return res.status(401).json({error: 'Authentication required'})
        return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`)
    }

    try {
        const userId = Number(req.session.user.id)
        const [[mapping]] = await pool.query(
            'SELECT database_name, role, is_active FROM app_user_workspaces WHERE user_id = ?', [userId]
        )
        if (mapping && !mapping.is_active) {
            if (req.path.startsWith('/api/')) {
                return res.status(403).json({error: 'This account is no longer active in the workspace.'})
            }
            return res.status(403).send('This account is no longer active in the workspace.')
        }
        let databaseName = mapping?.database_name
        let role = mapping?.role || 'owner'
        if (!databaseName) {
            databaseName = userId === workspaceOwnerId
                ? process.env.MYSQL_DATABASE
                : `${process.env.MYSQL_DATABASE}_account_${userId}`
            if (databaseName !== process.env.MYSQL_DATABASE) {
                await ensureWorkspaceDatabase(databaseName)
            }
            await pool.query(
                'INSERT INTO app_user_workspaces (user_id, database_name, role) VALUES (?, ?, ?)',
                [userId, databaseName, role]
            )
        } else if (databaseName !== process.env.MYSQL_DATABASE) {
            await ensureWorkspaceDatabase(databaseName)
        }

        req.session.user.workspaceDatabase = databaseName
        req.session.user.workspaceRole = role
        req.workspaceDatabase = databaseName
        req.workspaceRole = role
        res.locals.currentUser = req.session.user
        res.locals.workspaceRole = role
        res.locals.canManageMasterData = ['owner', 'admin'].includes(role)
        res.locals.csrfToken = req.session.csrfToken
        return runWithWorkspaceDatabase(databaseName, async () => {
            await ensureWorkspacePreferences()
            const [[preferences]] = await pool.query('SELECT currency_code, language_code FROM workspace_preferences WHERE id = 1')
            req.workspacePreferences = preferences
            res.locals.workspacePreferences = preferences
            next()
        })
    } catch (error) {
        return next(error)
    }
})

const createCsrfToken = (req) => {
    if (typeof req.session.csrfToken !== 'string' || !/^[a-f0-9]{64}$/.test(req.session.csrfToken)) {
        req.session.csrfToken = randomBytes(32).toString('hex')
    }
    return req.session.csrfToken
}

const setFlash = (req, type, message) => {
    req.session.flash = {type, message}
}

const requireWorkspaceRoles = (...allowedRoles) => (req, res, next) => {
    if (allowedRoles.includes(req.workspaceRole)) return next()
    if (req.path.startsWith('/api/')) {
        return res.status(403).json({error: 'Your workspace role cannot perform this action.'})
    }
    return res.status(403).send('Your workspace role cannot perform this action.')
}

const verifyCsrfToken = (req, token = req.body.csrfToken) => typeof token === 'string'
    && typeof req.session.csrfToken === 'string'
    && /^[a-f0-9]{64}$/.test(token)
    && timingSafeEqual(Buffer.from(token), Buffer.from(req.session.csrfToken))

app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
    if (!verifyCsrfToken(req, req.get('x-csrf-token'))) {
        return res.status(403).json({error: 'Your request token is invalid or expired. Refresh the page and try again.'})
    }
    return next()
})

app.use('/api/inventory', inventoryRouter);

const workspaceAuditLogChecks = new Map()

const ensureWorkspaceAuditLog = async () => {
    const [[database]] = await pool.query('SELECT DATABASE() AS databaseName')
    const databaseName = database.databaseName
    let check = workspaceAuditLogChecks.get(databaseName)
    if (!check) {
        check = pool.query(`
            CREATE TABLE IF NOT EXISTS workspace_audit_log (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                actor_user_id BIGINT UNSIGNED NOT NULL,
                actor_username VARCHAR(32) NOT NULL,
                actor_role ENUM('owner', 'admin', 'staff') NOT NULL,
                action VARCHAR(16) NOT NULL,
                resource VARCHAR(100) NOT NULL,
                target_id VARCHAR(100) NULL,
                status_code SMALLINT UNSIGNED NOT NULL,
                succeeded BOOLEAN NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_workspace_audit_created_at (created_at),
                INDEX idx_workspace_audit_actor (actor_user_id, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `).then(() => undefined)
        workspaceAuditLogChecks.set(databaseName, check)
        check.catch(() => workspaceAuditLogChecks.delete(databaseName))
    }
    await check
}



app.use(async (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.session.user || !req.workspaceDatabase) return next()
    try {
        await ensureWorkspaceAuditLog()
        const databaseName = req.workspaceDatabase
        const actorUserId = req.session.user.id
        const actorUsername = req.session.user.username
        const actorRole = req.workspaceRole
        const action = req.method
        const resource = req.path.split('/').filter(Boolean)[1] || req.path
        const targetId = req.path.match(/\/(\d+)(?:\/|$)/)?.[1] || null
        res.once('finish', () => {
            runWithWorkspaceDatabase(databaseName, () => pool.query(`
                INSERT INTO workspace_audit_log
                    (actor_user_id, actor_username, actor_role, action, resource, target_id, status_code, succeeded)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [actorUserId, actorUsername, actorRole, action, resource, targetId, res.statusCode, res.statusCode < 400]))
                .catch((error) => console.error('Unable to write workspace audit log:', error))
        })
        next()
    } catch (error) {
        next(error)
    }
})

const regenerateSession = (req) => new Promise((resolve, reject) => {
    req.session.regenerate((error) => error ? reject(error) : resolve())
})

const hashPassword = async (password) => {
    const salt = randomBytes(16)
    const hash = await scrypt(password, salt, 64)
    return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

const verifyPassword = async (password, storedHash) => {
    const [algorithm, saltHex, hashHex] = String(storedHash).split('$')
    if (algorithm !== 'scrypt' || !/^[0-9a-f]{32}$/i.test(saltHex) || !/^[0-9a-f]{128}$/i.test(hashHex)) return false
    const expected = Buffer.from(hashHex, 'hex')
    const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length)
    return timingSafeEqual(expected, actual)
}

const noCacheAuthHeaders = (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')
}

const renderAuth = (res, mode, error = null, csrfToken = '', next = '/', statusCode = error ? 400 : 200, inviteToken = '') => {
    noCacheAuthHeaders(res)
    return res.status(statusCode).render('auth', {
        layout: false,
        mode,
        isRegister: mode === 'register',
        error,
        csrfToken,
        next,
        inviteToken: inviteToken || String(res.req.body?.inviteToken || '')
    })
}

const createAuthRateLimit = (mode, limit) => rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => renderAuth(
        res,
        mode,
        'Too many attempts. Please wait 15 minutes and try again.',
        createCsrfToken(req),
        '/',
        429
    )
})

const loginRateLimit = createAuthRateLimit('login', 10)
const registrationRateLimit = createAuthRateLimit('register', 5)

app.get('/login', (req, res) => {
    noCacheAuthHeaders(res)
    if (req.session.user) return res.redirect('/')
    renderAuth(res, 'login', null, createCsrfToken(req), req.query.next || '/')
})

app.get("/easter_egg", (req,res) =>{
    res.render("easter_egg",{
        title:"easter_egg"
    })
})

app.get('/register', (req, res) => {
    noCacheAuthHeaders(res)
    if (req.session.user) return res.redirect('/')
    renderAuth(res, 'register', null, createCsrfToken(req))
})

app.get('/invite/:token', async (req, res) => {
    const inviteToken = String(req.params.token || '')
    if (!/^[a-f0-9]{64}$/i.test(inviteToken)) return res.status(404).send('Invitation not found.')
    try {
        const [[invite]] = await pool.query(`
            SELECT token_hash FROM app_workspace_invites
            WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > CURRENT_TIMESTAMP
        `, [createHash('sha256').update(inviteToken).digest('hex')])
        if (!invite) return res.status(404).send('This invitation is invalid or has expired.')
        renderAuth(res, 'register', null, createCsrfToken(req), '/', 200, inviteToken)
    } catch (error) {
        sendServerError(res, error)
    }
})

app.post('/register', registrationRateLimit, async (req, res) => {
    if (!verifyCsrfToken(req)) return renderAuth(res, 'register', 'Your form expired. Please try again.', createCsrfToken(req))
    const username = String(req.body.username || '').trim().toLowerCase()
    const email = String(req.body.email || '').trim().toLowerCase()
    const password = String(req.body.password || '')
    const inviteToken = String(req.body.inviteToken || '').trim()
    if (inviteToken && !/^[a-f0-9]{64}$/i.test(inviteToken)) {
        return renderAuth(res, 'register', 'This invitation is invalid or has expired.', createCsrfToken(req))
    }
    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
        return renderAuth(res, 'register', 'Username must be 3-32 characters and use letters, numbers, dots, underscores, or hyphens.', createCsrfToken(req))
    }
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return renderAuth(res, 'register', 'Enter a valid email address.', createCsrfToken(req))
    }
    if (password.length < 8 || password.length > 128) {
        return renderAuth(res, 'register', 'Password must be between 8 and 128 characters.', createCsrfToken(req))
    }
    let connection
    try {
        connection = await pool.getConnection()
        await connection.beginTransaction()
        let invite = null
        if (inviteToken) {
            const [[pendingInvite]] = await connection.query(`
                SELECT database_name, role
                FROM app_workspace_invites
                WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > CURRENT_TIMESTAMP
                FOR UPDATE
            `, [createHash('sha256').update(inviteToken).digest('hex')])
            if (!pendingInvite) {
                await connection.rollback()
                return renderAuth(res, 'register', 'This invitation is invalid or has expired.', createCsrfToken(req))
            }
            invite = pendingInvite
        }

        const passwordHash = await hashPassword(password)
        const [result] = await connection.query(
            'INSERT INTO app_users (username, email, password_hash) VALUES (?, ?, ?)',
            [username, email, passwordHash]
        )

        let databaseName
        let workspaceRole = 'owner'
        let nextWorkspaceOwnerId = workspaceOwnerId
        if (invite) {
            databaseName = invite.database_name
            workspaceRole = invite.role
            await ensureWorkspaceDatabase(databaseName)
            await connection.query(
                'INSERT INTO app_user_workspaces (user_id, database_name, role) VALUES (?, ?, ?)',
                [result.insertId, databaseName, workspaceRole]
            )
            await connection.query(`
                UPDATE app_workspace_invites
                SET accepted_by = ?, accepted_at = CURRENT_TIMESTAMP
                WHERE token_hash = ? AND accepted_at IS NULL
            `, [result.insertId, createHash('sha256').update(inviteToken).digest('hex')])
        } else {
            if (!nextWorkspaceOwnerId) {
                await connection.query(`
                    INSERT INTO app_workspace (id, owner_user_id) VALUES (1, ?)
                    ON DUPLICATE KEY UPDATE owner_user_id = COALESCE(owner_user_id, VALUES(owner_user_id))
                `, [result.insertId])
                const [[workspace]] = await connection.query('SELECT owner_user_id FROM app_workspace WHERE id = 1')
                nextWorkspaceOwnerId = Number(workspace.owner_user_id)
            }
            databaseName = Number(nextWorkspaceOwnerId) === Number(result.insertId)
                ? process.env.MYSQL_DATABASE
                : `${process.env.MYSQL_DATABASE}_account_${result.insertId}`
            if (databaseName !== process.env.MYSQL_DATABASE) {
                await ensureWorkspaceDatabase(databaseName)
            }
            await connection.query(
                'INSERT INTO app_user_workspaces (user_id, database_name, role) VALUES (?, ?, \'owner\')',
                [result.insertId, databaseName]
            )
        }

        await connection.commit()
        workspaceOwnerId = nextWorkspaceOwnerId
        try {
            await runWithWorkspaceDatabase(databaseName, async () => {
                await ensureWorkspaceAuditLog()
                await pool.query(`
                    INSERT INTO workspace_audit_log
                        (actor_user_id, actor_username, actor_role, action, resource, target_id, status_code, succeeded)
                    VALUES (?, ?, ?, ?, 'workspace-members', ?, 201, TRUE)
                `, [result.insertId, username, workspaceRole, invite ? 'INVITE_ACCEPT' : 'WORKSPACE_CREATE', result.insertId])
            })
        } catch (auditError) {
            console.error('Unable to audit workspace registration:', auditError)
        }
        await regenerateSession(req)
        req.session.user = {id: result.insertId, username, email, workspaceDatabase: databaseName, workspaceRole}
        req.session.csrfToken = randomBytes(32).toString('hex')
        setFlash(req, 'success', 'Account created successfully. Welcome to StockFlow.')
        res.redirect('/')
    } catch (error) {
        if (connection) await connection.rollback()
        if (error.code === 'ER_DUP_ENTRY') {
            return renderAuth(res, 'register', 'That username or email is already registered.', createCsrfToken(req))
        }
        console.error(error)
        renderAuth(res, 'register', 'Account creation failed. Please try again.', createCsrfToken(req))
    } finally {
        connection?.release()
    }
})

app.post('/login', loginRateLimit, async (req, res) => {
    noCacheAuthHeaders(res)
    const next = typeof req.body.next === 'string'
        && req.body.next.startsWith('/')
        && !req.body.next.startsWith('//')
        && !req.body.next.includes('\\')
        ? req.body.next
        : '/'
    if (!verifyCsrfToken(req)) return renderAuth(res, 'login', 'Your form expired. Please try again.', createCsrfToken(req), next)
    const identity = String(req.body.identity || '').trim().toLowerCase()
    const password = String(req.body.password || '')
    try {
        const [[user]] = await pool.query(
            'SELECT id, username, email, password_hash FROM app_users WHERE username = ? OR email = ? LIMIT 1',
            [identity, identity]
        )
        if (!user || password.length > 128 || !await verifyPassword(password, user.password_hash)) {
            return renderAuth(res, 'login', 'Incorrect username/email or password.', createCsrfToken(req))
        }
        await regenerateSession(req)
        req.session.user = {id: user.id, username: user.username, email: user.email}
        req.session.csrfToken = randomBytes(32).toString('hex')
        setFlash(req, 'success', 'Signed in successfully.')
        res.redirect(next)
    } catch (error) {
        console.error(error)
        renderAuth(res, 'login', 'Sign in failed. Please try again.', createCsrfToken(req))
    }
})

app.post('/logout', (req, res, next) => {
    if (!verifyCsrfToken(req)) return res.status(403).send('Invalid form token')
    req.session.destroy((error) => {
        if (error) return next(error)
        res.clearCookie('stockflow.sid', {httpOnly: true, sameSite: 'lax', secure: production})
        res.redirect('/login')
    })
})

const positiveNumber = (value, fieldName) => {
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0) {
        throw new Error(`${fieldName} must be greater than zero`)
    }
    return number
}

const requiredId = (value, fieldName) => {
    const id = Number(value)
    if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`${fieldName} must be a valid id`)
    }
    return id
}

const requiredText = (value, fieldName) => {
    const text = String(value || '').trim()
    if (!text) throw new Error(`${fieldName} is required`)
    return text
}

const requiredDate = (value, fieldName) => {
    const date = value instanceof Date
        ? [
            value.getFullYear(),
            String(value.getMonth() + 1).padStart(2, '0'),
            String(value.getDate()).padStart(2, '0')
        ].join('-')
        : String(value || '').trim()
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
    if (!match) {
        throw new Error(`${fieldName} must be a valid date`)
    }
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const parsed = new Date(Date.UTC(year, month - 1, day))
    if (parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() !== month - 1 ||
        parsed.getUTCDate() !== day) {
        throw new Error(`${fieldName} must be a valid date`)
    }
    return date
}

const makeNumber = (prefix) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`

const sendError = (res, error) => {
    console.error(error)
    const duplicate = error.code === 'ER_DUP_ENTRY'
    const status = duplicate ? 409 : error.code ? 500 : 400
    const message = status === 500
        ? 'An unexpected error occurred.'
        : duplicate
            ? 'A record with those details already exists.'
            : error.message
    res.status(status).json({error: message})
}

const sendServerError = (res, error) => {
    console.error(error)
    res.status(500).send('Unable to complete the request.')
}

const csvCell = (value) => {
    if (value === null || value === undefined) return '""'
    const text = value instanceof Date ? value.toISOString() : String(value)
    const safeText = /^[=+@\t\r]/.test(text) || (text.startsWith('-') && !Number.isFinite(Number(text)))
        ? `'${text}`
        : text
    return `"${safeText.replace(/"/g, '""')}"`
}

const getBackupEncryptionKey = () => {
    const encodedKey = String(process.env.BACKUP_ENCRYPTION_KEY || '').trim()
    const key = Buffer.from(encodedKey, 'base64')
    if (!encodedKey || key.length !== 32 || key.toString('base64') !== encodedKey) {
        throw new Error('Set BACKUP_ENCRYPTION_KEY to a base64-encoded 32-byte key before using backups.')
    }
    return key
}

const backupRootDirectory = () => path.resolve(process.env.BACKUP_DIR || 'backups')

const quoteBackupTable = (tableName) => {
    if (!/^[A-Za-z0-9_]+$/.test(tableName)) throw new Error('Backup contains an invalid table name.')
    return `\`${tableName}\``
}

const encodeBackupValue = (value) => {
    if (Buffer.isBuffer(value)) return {__stockFlowType: 'buffer', value: value.toString('base64')}
    if (value instanceof Date) return {__stockFlowType: 'date', value: value.toISOString().replace('T', ' ').replace('Z', '')}
    return value
}

const decodeBackupValue = (value) => {
    if (!value || typeof value !== 'object' || !value.__stockFlowType) return value
    if (value.__stockFlowType === 'buffer') return Buffer.from(value.value, 'base64')
    if (value.__stockFlowType === 'date') return value.value
    throw new Error('Backup contains an unsupported value type.')
}

const createEncryptedWorkspaceBackup = async (databaseName) => {
    if (!/^[A-Za-z0-9_]+$/.test(databaseName)) throw new Error('Invalid workspace database name.')
    const key = getBackupEncryptionKey()
    const snapshot = await runWithWorkspaceDatabase(databaseName, async () => {
        const [tables] = await pool.query(`
            SELECT TABLE_NAME AS tableName
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
              AND TABLE_NAME NOT IN ('app_users', 'app_sessions', 'app_workspace', 'app_user_workspaces', 'app_workspace_invites')
            ORDER BY TABLE_NAME
        `)
        const tableSnapshots = []
        for (const {tableName} of tables) {
            const quotedTable = quoteBackupTable(tableName)
            const [columns] = await pool.query(`SHOW COLUMNS FROM ${quotedTable}`)
            const [rows] = await pool.query(`SELECT * FROM ${quotedTable}`)
            tableSnapshots.push({
                name: tableName,
                columns: columns.map((column) => column.Field),
                rows: rows.map((row) => Object.fromEntries(
                    Object.entries(row).map(([columnName, value]) => [columnName, encodeBackupValue(value)])
                ))
            })
        }
        return {
            format: 'stockflow-workspace-backup',
            version: 1,
            databaseName,
            createdAt: new Date().toISOString(),
            tables: tableSnapshots
        }
    })
    const compressed = gzipSync(Buffer.from(JSON.stringify(snapshot)))
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()])
    const backup = Buffer.concat([Buffer.from('STOCKFLOW-BACKUP-V1\0'), iv, cipher.getAuthTag(), ciphertext])
    const directory = path.join(backupRootDirectory(), databaseName)
    await mkdir(directory, {recursive: true})
    const fileName = `backup-${new Date().toISOString().slice(0, 10)}.sfbak`
    const filePath = path.join(directory, fileName)
    const temporaryPath = `${filePath}.tmp`
    await writeFile(temporaryPath, backup, {mode: 0o600})
    await rename(temporaryPath, filePath)
    const files = (await readdir(directory))
        .filter((name) => /^backup-\d{4}-\d{2}-\d{2}\.sfbak$/.test(name))
        .sort((left, right) => right.localeCompare(left))
    for (const oldFile of files.slice(7)) {
        await unlink(path.join(directory, oldFile))
    }
    return {fileName, filePath, createdAt: snapshot.createdAt}
}

const decryptWorkspaceBackup = (encryptedBackup) => {
    const prefix = Buffer.from('STOCKFLOW-BACKUP-V1\0')
    if (!Buffer.isBuffer(encryptedBackup) || encryptedBackup.length <= prefix.length + 28
        || !encryptedBackup.subarray(0, prefix.length).equals(prefix)) {
        throw new Error('This is not a valid StockFlow backup file.')
    }
    const key = getBackupEncryptionKey()
    const ivStart = prefix.length
    const tagStart = ivStart + 12
    const dataStart = tagStart + 16
    const decipher = createDecipheriv('aes-256-gcm', key, encryptedBackup.subarray(ivStart, tagStart))
    decipher.setAuthTag(encryptedBackup.subarray(tagStart, dataStart))
    const compressed = Buffer.concat([decipher.update(encryptedBackup.subarray(dataStart)), decipher.final()])
    return JSON.parse(gunzipSync(compressed).toString('utf8'))
}

const restoreWorkspaceSnapshot = async (databaseName, snapshot) => {
    if (snapshot?.format !== 'stockflow-workspace-backup' || snapshot.version !== 1
        || snapshot.databaseName !== databaseName || !Array.isArray(snapshot.tables)) {
        throw new Error('Backup does not match this workspace or uses an unsupported format.')
    }
    return runWithWorkspaceDatabase(databaseName, async () => {
        const [tableRows] = await pool.query(`
            SELECT TABLE_NAME AS tableName
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
              AND TABLE_NAME NOT IN ('app_users', 'app_sessions', 'app_workspace', 'app_user_workspaces', 'app_workspace_invites')
            ORDER BY TABLE_NAME
        `)
        const existingTableNames = tableRows.map((row) => row.tableName).sort()
        const backupTableNames = snapshot.tables.map((table) => table?.name).sort()
        if (new Set(backupTableNames).size !== backupTableNames.length
            || JSON.stringify(existingTableNames) !== JSON.stringify(backupTableNames)) {
            throw new Error('Backup tables do not match this workspace schema.')
        }

        for (const table of snapshot.tables) {
            if (!Array.isArray(table.columns) || !Array.isArray(table.rows)) {
                throw new Error('Backup contains an invalid table record.')
            }
            const [columns] = await pool.query(`SHOW COLUMNS FROM ${quoteBackupTable(table.name)}`)
            const currentColumns = columns.map((column) => column.Field)
            if (JSON.stringify(currentColumns) !== JSON.stringify(table.columns)) {
                throw new Error(`Backup columns do not match the current ${table.name} table.`)
            }
            const expectedKeys = [...currentColumns].sort()
            if (table.rows.some((row) => !row || typeof row !== 'object'
                || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(expectedKeys))) {
                throw new Error(`Backup rows are invalid for ${table.name}.`)
            }
        }

        const connection = await pool.getConnection()
        let transactionStarted = false
        try {
            await connection.query('SET FOREIGN_KEY_CHECKS = 0')
            await connection.beginTransaction()
            transactionStarted = true
            for (const tableName of existingTableNames) {
                await connection.query(`DELETE FROM ${quoteBackupTable(tableName)}`)
            }
            for (const table of snapshot.tables) {
                if (!table.rows.length) continue
                const quotedColumns = table.columns.map(quoteBackupTable).join(', ')
                const rowPlaceholder = `(${table.columns.map(() => '?').join(', ')})`
                for (let offset = 0; offset < table.rows.length; offset += 250) {
                    const rows = table.rows.slice(offset, offset + 250)
                    const values = rows.flatMap((row) => table.columns.map((column) => decodeBackupValue(row[column])))
                    const placeholders = rows.map(() => rowPlaceholder).join(', ')
                    await connection.query(
                        `INSERT INTO ${quoteBackupTable(table.name)} (${quotedColumns}) VALUES ${placeholders}`,
                        values
                    )
                }
            }
            await connection.commit()
            transactionStarted = false
        } catch (error) {
            if (transactionStarted) await connection.rollback()
            throw error
        } finally {
            await connection.query('SET FOREIGN_KEY_CHECKS = 1')
            connection.release()
        }
    })
}

const addInventory = async (connection, itemId, warehouseId, shelfId, quantity) => {
    await connection.query(
        `INSERT INTO inventory (item_id, warehouse_id, shelf_id, quantity)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
        [itemId, warehouseId, shelfId, quantity]
    )
}

const getItemCost = async (connection, itemId) => {
    const [[row]] = await connection.query(
        'SELECT avg_cost, markup_pct FROM item_costs WHERE item_id = ?', [itemId]
    )
    return row
        ? {avgCost: Number(row.avg_cost), markupPct: Number(row.markup_pct)}
        : {avgCost: 0, markupPct: 30}
}

const recalcAvgCost = async (connection, itemId, addedQty, purchaseUnitCost) => {
    const [[before]] = await connection.query(
        'SELECT COALESCE(SUM(quantity), 0) AS total_qty FROM inventory WHERE item_id = ?', [itemId]
    )
    const oldQty = Number(before.total_qty)
    const {avgCost: oldAvg} = await getItemCost(connection, itemId)
    const newAvg = (oldQty + addedQty) > 0
        ? (oldQty * oldAvg + addedQty * purchaseUnitCost) / (oldQty + addedQty)
        : purchaseUnitCost
    await connection.query(
        `INSERT INTO item_costs (item_id, avg_cost)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE avg_cost = VALUES(avg_cost), updated_at = CURRENT_TIMESTAMP`,
        [itemId, newAvg]
    )
    return newAvg
}

const addFifoLayer = async (connection, itemId, warehouseId, shelfId, quantity, unitCost, referenceNumber, receivedAt = null, productionDate = null) => {
    await connection.query(`
        INSERT INTO inventory_cost_layers
        (item_id, warehouse_id, shelf_id, quantity, remaining_quantity, unit_cost, reference_number, received_at, production_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?)
    `, [itemId, warehouseId, shelfId, quantity, quantity, unitCost, referenceNumber, receivedAt, productionDate])
}

const consumeFifoLayers = async (
    connection,
    itemId,
    warehouseId,
    shelfId,
    quantity,
    calculateCogs = true,
    requireFullCoverage = true
) => {
    const [layers] = await connection.query(`
    SELECT id, remaining_quantity, unit_cost, production_date
        FROM inventory_cost_layers
        WHERE item_id = ? AND warehouse_id = ? AND shelf_id = ? AND remaining_quantity > 0
        ORDER BY received_at, id
        FOR UPDATE
    `, [itemId, warehouseId, shelfId])
    let remaining = quantity
    let fifoCogs = 0
    const consumed = []
    for (const layer of layers) {
        if (remaining <= 0) break
        const used = Math.min(remaining, Number(layer.remaining_quantity))
        const unitCost = Number(layer.unit_cost)
        await connection.query(
            'UPDATE inventory_cost_layers SET remaining_quantity = remaining_quantity - ? WHERE id = ?',
            [used, layer.id]
        )
        if (calculateCogs) fifoCogs += used * unitCost
        consumed.push({id: layer.id, quantity: used, unitCost, productionDate: layer.production_date})
        remaining -= used
    }
    if (remaining > 0.000001 && requireFullCoverage) {
        throw new Error('FIFO cost layers do not cover this stock. Run the FIFO migration before selling.')
    }
    return {
        fifoCogs,
        breakdown: consumed.map((layer) => `${layer.id}:${layer.quantity}@${layer.unitCost} (${layer.productionDate || 'no date'})`).join(', '),
        productionDate: consumed[0]?.productionDate || null
    }
}

const transferFifoLayers = async (connection, itemId, fromWarehouseId, shelfId, toWarehouseId, toShelfId, quantity, referenceNumber) => {
    const [layers] = await connection.query(`
        SELECT id, remaining_quantity, unit_cost, received_at, production_date
        FROM inventory_cost_layers
        WHERE item_id = ? AND warehouse_id = ? AND shelf_id = ? AND remaining_quantity > 0
        ORDER BY received_at, id
        FOR UPDATE
    `, [itemId, fromWarehouseId, shelfId])
    let remaining = quantity
    for (const layer of layers) {
        if (remaining <= 0) break
        const moved = Math.min(remaining, Number(layer.remaining_quantity))
        await connection.query(
            'UPDATE inventory_cost_layers SET remaining_quantity = remaining_quantity - ? WHERE id = ?',
            [moved, layer.id]
        )
        await addFifoLayer(connection, itemId, toWarehouseId, toShelfId, moved, Number(layer.unit_cost), referenceNumber, layer.received_at, layer.production_date)
        remaining -= moved
    }
    if (remaining > 0.000001) {
        throw new Error('FIFO cost layers do not cover this transfer. Run the FIFO migration before transferring.')
    }
}

app.get('/', async (req, res) => {
    try {
        await ensureFinancialJournalDueDates()
        await ensurePreOrdersTable()
        await ensureWorkspaceOnboardingTable()
        const [[summary]] = await pool.query(`
            SELECT
                (SELECT COUNT(*) FROM items) AS item_count,
                (SELECT COALESCE(SUM(quantity), 0) FROM inventory) AS total_stock,
                (SELECT COUNT(*) FROM purchase_orders WHERE status = 'PENDING') AS pending_orders,
                (SELECT COUNT(*) FROM stock_transfers WHERE status = 'PENDING') AS pending_transfers,
                (SELECT COUNT(*) FROM pre_orders WHERE status = 'PENDING') AS pending_preorders,
                (SELECT COUNT(*) FROM (
                    SELECT i.id
                    FROM items i LEFT JOIN inventory inv ON inv.item_id = i.id
                    GROUP BY i.id, i.minimum_stock
                    HAVING i.minimum_stock > 0 AND COALESCE(SUM(inv.quantity), 0) <= i.minimum_stock
                ) AS low_stock_rows) AS low_stock_items
        `)
        const [[dueSummary]] = await pool.query(`
            SELECT COUNT(*) AS due_count, COALESCE(SUM(amount), 0) AS due_amount
            FROM (
                SELECT CASE WHEN COALESCE(remaining_debt, 0) > 0 THEN remaining_debt
                            ELSE remaining_receivables END AS amount
                FROM financial_journal
                WHERE (COALESCE(remaining_debt, 0) > 0 AND purchase_due_date <= CURRENT_DATE())
                   OR (COALESCE(remaining_receivables, 0) > 0 AND sale_due_date <= CURRENT_DATE())
            ) AS due_rows
        `)
        const [[setupCounts]] = await pool.query(`
            SELECT
                (SELECT COUNT(*) FROM warehouse) AS warehouse_count,
                (SELECT COUNT(*) FROM shelves) AS shelf_count,
                (SELECT COUNT(*) FROM items) AS item_count,
                (SELECT COUNT(*) FROM suppliers) AS supplier_count,
                (SELECT COUNT(*) FROM inventory WHERE quantity > 0) AS stocked_positions
        `)
        const [[onboarding]] = await pool.query('SELECT status FROM workspace_onboarding WHERE id = 1')
        const setupSteps = [
            {label: 'Create a warehouse and shelf', href: '/master-data', complete: Number(setupCounts.warehouse_count) > 0 && Number(setupCounts.shelf_count) > 0},
            {label: 'Add your first item', href: '/master-data', complete: Number(setupCounts.item_count) > 0},
            {label: 'Add a supplier', href: '/master-data', complete: Number(setupCounts.supplier_count) > 0},
            {label: 'Receive your first stock', href: '/purchase-orders', complete: Number(setupCounts.stocked_positions) > 0}
        ]
        const setupComplete = setupSteps.every((step) => step.complete)
        if (setupComplete && onboarding.status === 'active') {
            await pool.query("UPDATE workspace_onboarding SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = 1")
        }
        const showOnboarding = !setupComplete && onboarding.status === 'active'
        const onboardingHidden = !setupComplete && onboarding.status === 'skipped'
        const [transactions] = await pool.query(`
            SELECT t.*, i.item_name, w.warehouse_name
            FROM inventory_transactions t
            JOIN items i ON i.id = t.item_id
            JOIN warehouse w ON w.id = t.warehouse_id
            ORDER BY t.created_at DESC
            LIMIT 10
        `)
        res.render('index', {summary, dueSummary, transactions, setupSteps, setupComplete, showOnboarding, onboardingHidden})
    } catch (error) {
        sendServerError(res, error)
    }
})

app.get('/about', (req, res) => res.render('about'))
app.get('/tutorial', (req, res) => res.render('tutorial'))

app.get('/workspace-members', async (req, res) => {
    try {
         const [members] = await runWithBaseDatabase(() => pool.query(`
            SELECT u.id, u.username, u.email, membership.role, membership.is_active,
                   DATE_FORMAT(membership.created_at, '%Y-%m-%d') AS joined_date
            FROM app_user_workspaces membership
            JOIN app_users u ON u.id = membership.user_id
            WHERE membership.database_name = ?
            ORDER BY FIELD(membership.role, 'owner', 'admin', 'staff'), u.username
        `, [req.workspaceDatabase]))
        const [invites] = await runWithBaseDatabase(() => pool.query(`
            SELECT role, expires_at, created_at
            FROM app_workspace_invites
            WHERE database_name = ? AND accepted_at IS NULL AND expires_at > CURRENT_TIMESTAMP
            ORDER BY created_at DESC
        `, [req.workspaceDatabase]))
        res.render('workspace-members', {
            members,
            invites,
            canManage: ['owner', 'admin'].includes(req.workspaceRole),
            isOwner: req.workspaceRole === 'owner'
        })
    } catch (error) {
        sendServerError(res, error)
    }
})

app.get('/workspace-settings', requireWorkspaceRoles('owner', 'admin'), (req, res) => {
    res.render('workspace-settings')
})

app.patch('/api/workspace-settings/preferences', requireWorkspaceRoles('owner', 'admin'), async (req, res) => {
    try {
        const currencyCode = String(req.body.currencyCode || '').trim().toUpperCase()
        const languageCode = String(req.body.languageCode || '').trim().toLowerCase()
        const supportedCurrencies = new Set(['AUD', 'EUR', 'GBP', 'IDR', 'JPY', 'MYR', 'SGD', 'USD'])
        if (!supportedCurrencies.has(currencyCode)) throw new Error('Choose a supported display currency')
        if (!['en', 'id'].includes(languageCode)) throw new Error('Choose English or Bahasa Indonesia')
        await ensureWorkspacePreferences()
        await pool.query(`
            UPDATE workspace_preferences
            SET currency_code = ?, language_code = ?
            WHERE id = 1
        `, [currencyCode, languageCode])
        res.json({message: 'Workspace language and currency saved'})
    } catch (error) {
        sendError(res, error)
    }
})

app.get('/audit-log', requireWorkspaceRoles('owner', 'admin'), async (req, res) => {
    try {
        await ensureWorkspaceAuditLog()
        const [events] = await pool.query(`
            SELECT actor_username, actor_role, action, resource, target_id, status_code,
                   succeeded, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
            FROM workspace_audit_log
            ORDER BY id DESC
            LIMIT 200
        `)
        res.render('audit-log', {events})
    } catch (error) {
        sendServerError(res, error)
    }
})

app.get('/backups', requireWorkspaceRoles('owner'), async (req, res) => {
    let backups = []
    try {
        getBackupEncryptionKey()
        try {
            const directory = path.join(backupRootDirectory(), req.workspaceDatabase)
            const names = (await readdir(directory))
                .filter((name) => /^backup-\d{4}-\d{2}-\d{2}\.sfbak$/.test(name))
                .sort((left, right) => right.localeCompare(left))
            backups = names.map((fileName) => ({fileName, href: `/api/backups/download/${fileName}`}))
        } catch (error) {
            if (error.code !== 'ENOENT') throw error
        }
        res.render('backups', {backups, encryptionConfigured: true})
    } catch (error) {
        res.render('backups', {backups, encryptionConfigured: false, backupSetupMessage: error.message})
    }
})

app.get('/api/backups/export', requireWorkspaceRoles('owner'), async (req, res) => {
    try {
        const backup = await createEncryptedWorkspaceBackup(req.workspaceDatabase)
        await ensureWorkspaceAuditLog()
        await pool.query(`
            INSERT INTO workspace_audit_log
                (actor_user_id, actor_username, actor_role, action, resource, target_id, status_code, succeeded)
            VALUES (?, ?, ?, 'BACKUP', 'workspace', ?, 200, TRUE)
        `, [req.session.user.id, req.session.user.username, req.workspaceRole, backup.fileName])
        res.type('application/octet-stream')
            .attachment(backup.fileName)
            .send(await readFile(backup.filePath))
    } catch (error) {
        sendError(res, error)
    }
})

app.get('/api/backups/download/:fileName', requireWorkspaceRoles('owner'), async (req, res) => {
    try {
        const fileName = String(req.params.fileName || '')
        if (!/^backup-\d{4}-\d{2}-\d{2}\.sfbak$/.test(fileName)) {
            return res.status(400).json({error: 'Backup filename is invalid.'})
        }
        const filePath = path.join(backupRootDirectory(), req.workspaceDatabase, fileName)
        res.type('application/octet-stream').attachment(fileName).send(await readFile(filePath))
    } catch (error) {
        sendError(res, error)
    }
})

app.post('/api/backups/restore', requireWorkspaceRoles('owner'), express.raw({type: 'application/octet-stream', limit: '250mb'}), async (req, res) => {
    try {
        const snapshot = decryptWorkspaceBackup(req.body)
        await restoreWorkspaceSnapshot(req.workspaceDatabase, snapshot)
        res.json({message: 'Workspace restored from the encrypted backup.'})
    } catch (error) {
        sendError(res, error)
    }
})

app.post('/api/workspace-invites', requireWorkspaceRoles('owner', 'admin'), async (req, res) => {
    try {
        const role = String(req.body.role || '').trim().toLowerCase()
        if (!['admin', 'staff'].includes(role)) throw new Error('Invite role must be admin or staff')
        if (req.workspaceRole === 'admin' && role !== 'staff') {
            throw new Error('Admins can invite staff only')
        }
        const token = randomBytes(32).toString('hex')
        const tokenHash = createHash('sha256').update(token).digest('hex')
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            .toISOString().slice(0, 19).replace('T', ' ')
        await runWithBaseDatabase(async () => {
            await pool.query(`
                DELETE FROM app_workspace_invites
                WHERE database_name = ? AND accepted_at IS NULL AND expires_at <= CURRENT_TIMESTAMP
            `, [req.workspaceDatabase])
            await pool.query(`
                INSERT INTO app_workspace_invites (token_hash, database_name, role, created_by, expires_at)
                VALUES (?, ?, ?, ?, ?)
            `, [tokenHash, req.workspaceDatabase, role, req.session.user.id, expiresAt])
        })
        res.status(201).json({message: 'Invitation created. Share this link within seven days.', invitePath: `/invite/${token}`, expiresAt})
    } catch (error) {
        sendError(res, error)
    }
})

app.patch('/api/workspace-members/:userId/role', requireWorkspaceRoles('owner'), async (req, res) => {
    try {
        const userId = requiredId(req.params.userId, 'userId')
        const role = String(req.body.role || '').trim().toLowerCase()
        if (!['admin', 'staff'].includes(role)) throw new Error('Role must be admin or staff')
        if (userId === Number(req.session.user.id)) throw new Error('Your owner role cannot be changed here')
        const [result] = await runWithBaseDatabase(() => pool.query(`
            UPDATE app_user_workspaces
            SET role = ?
            WHERE user_id = ? AND database_name = ? AND role <> 'owner'
        `, [role, userId, req.workspaceDatabase]))
        if (!result.affectedRows) throw new Error('Workspace member not found or cannot be changed')
        res.json({message: 'Member role updated'})
    } catch (error) {
        sendError(res, error)
    }
})

app.patch('/api/workspace-members/:userId/active', requireWorkspaceRoles('owner'), async (req, res) => {
    try {
        const userId = requiredId(req.params.userId, 'userId')
        if (userId === Number(req.session.user.id)) throw new Error('You cannot deactivate your own account')
        const isActive = req.body.isActive === true
        const [result] = await runWithBaseDatabase(() => pool.query(`
            UPDATE app_user_workspaces
            SET is_active = ?
            WHERE user_id = ? AND database_name = ? AND role <> 'owner'
        `, [isActive, userId, req.workspaceDatabase]))
        if (!result.affectedRows) throw new Error('Workspace member not found or cannot be changed')
        res.json({message: isActive ? 'Member access restored' : 'Member access revoked'})
    } catch (error) {
        sendError(res, error)
    }
})

app.patch('/api/onboarding/status', requireWorkspaceRoles('owner', 'admin'), async (req, res) => {
    try {
        const status = String(req.body.status || '').trim().toLowerCase()
        if (!['active', 'skipped'].includes(status)) throw new Error('Onboarding status must be active or skipped')
        await ensureWorkspaceOnboardingTable()
        await pool.query('UPDATE workspace_onboarding SET status = ? WHERE id = 1', [status])
        res.json({message: status === 'skipped' ? 'Setup checklist hidden' : 'Setup checklist reopened'})
    } catch (error) {
        sendError(res, error)
    }
})

app.get('/api/lookups', async (req, res) => {
    try {
        const [[items], [warehouses], [suppliers]] = await Promise.all([
            pool.query(`
                SELECT i.id, i.item_name, i.item_code, b.brand_name
                FROM items i
                JOIN brands b ON b.id = i.brand_id
                ORDER BY i.item_name
            `),
            pool.query('SELECT id, warehouse_name FROM warehouse ORDER BY warehouse_name'),
            pool.query('SELECT id, supplier_name FROM suppliers ORDER BY supplier_name')
        ])
        const [shelves] = await pool.query(`
            SELECT s.id, s.warehouse_id, s.shelf_code
            FROM shelves s ORDER BY s.warehouse_id, s.shelf_code
        `)
        res.json({items, warehouses, shelves, suppliers})
    } catch (error) {
        sendError(res, error)
    }
})

app.post('/api/transfers', async (req, res) => {
    const connection = await pool.getConnection()
    try {
        const fromWarehouseId = requiredId(req.body.fromWarehouseId, 'fromWarehouseId')
        const toWarehouseId = requiredId(req.body.toWarehouseId, 'toWarehouseId')
        if (fromWarehouseId === toWarehouseId) throw new Error('Source and destination warehouses must differ')
        if (!Array.isArray(req.body.items) || req.body.items.length === 0) throw new Error('At least one transfer item is required')

        const transferNumber = req.body.transferNumber || makeNumber('TRF')
        await connection.beginTransaction()
        const [[destinationShelf]] = await connection.query(
            'SELECT id FROM shelves WHERE warehouse_id = ? ORDER BY id LIMIT 1 FOR UPDATE',
            [toWarehouseId]
        )
        if (!destinationShelf) throw new Error('The destination warehouse has no shelf')

        const [transfer] = await connection.query(
            `INSERT INTO stock_transfers
             (transfer_number, from_warehouse_id, to_warehouse_id, status, notes)
             VALUES (?, ?, ?, 'COMPLETED', ?)`,
            [transferNumber, fromWarehouseId, toWarehouseId, req.body.notes || null]
        )

        for (const requestedItem of req.body.items) {
            const itemId = requiredId(requestedItem.itemId, 'itemId')
            const quantity = positiveNumber(requestedItem.quantity, 'quantity')
            let remaining = quantity
            const [sourceRows] = await connection.query(`
                SELECT id, shelf_id, quantity
                FROM inventory
                WHERE item_id = ? AND warehouse_id = ? AND quantity > 0
                ORDER BY id FOR UPDATE
            `, [itemId, fromWarehouseId])
            for (const source of sourceRows) {
                if (remaining <= 0) break
                const moved = Math.min(remaining, Number(source.quantity))
                await transferFifoLayers(connection, itemId, fromWarehouseId, source.shelf_id, toWarehouseId, destinationShelf.id, moved, transferNumber)
                await connection.query('UPDATE inventory SET quantity = quantity - ? WHERE id = ?', [moved, source.id])
                await connection.query(`
                    INSERT INTO inventory_transactions
                    (item_id, warehouse_id, shelf_id, transaction_type, quantity, reference_number, notes)
                    VALUES (?, ?, ?, 'OUT', ?, ?, ?)
                `, [itemId, fromWarehouseId, source.shelf_id, moved, transferNumber, 'Stock transfer'])
                remaining -= moved
            }
            if (remaining > 0) throw new Error(`Insufficient stock for item ${itemId}`)
            await addInventory(connection, itemId, toWarehouseId, destinationShelf.id, quantity)
            await connection.query(`
                INSERT INTO stock_transfer_items (transfer_id, item_id, quantity)
                VALUES (?, ?, ?)
            `, [transfer.insertId, itemId, quantity])
            await connection.query(`
                INSERT INTO inventory_transactions
                (item_id, warehouse_id, shelf_id, transaction_type, quantity, reference_number, notes)
                VALUES (?, ?, ?, 'IN', ?, ?, ?)
            `, [itemId, toWarehouseId, destinationShelf.id, quantity, transferNumber, 'Stock transfer'])
        }
        await connection.commit()
        res.status(201).json({message: 'Transfer completed', transferNumber})
    } catch (error) {
        await connection.rollback()
        sendError(res, error)
    } finally {
        connection.release()
    }
})

app.post('/api/purchase-orders', async (req, res) => {
    const connection = await pool.getConnection()
    try {
        const supplierId = requiredId(req.body.supplierId, 'supplierId')
        if (!Array.isArray(req.body.items) || req.body.items.length === 0) throw new Error('At least one purchase-order item is required')
        const poNumber = req.body.poNumber || makeNumber('PO')
        await connection.beginTransaction()
        const [purchaseOrder] = await connection.query(`
            INSERT INTO purchase_orders (supplier_id, po_number, po_date)
            VALUES (?, ?, COALESCE(?, CURDATE()))
        `, [supplierId, poNumber, req.body.poDate || null])
        for (const requestedItem of req.body.items) {
            await connection.query(`
                INSERT INTO purchase_order_items (purchase_order_id, item_id, quantity, unit_cost, production_date)
                VALUES (?, ?, ?, ?, ?)
            `, [
                purchaseOrder.insertId,
                requiredId(requestedItem.itemId, 'itemId'),
                positiveNumber(requestedItem.quantity, 'quantity'),
                positiveNumber(requestedItem.unitCost, 'unitCost'),
                requiredDate(requestedItem.productionDate, 'productionDate')
            ])
        }
        await connection.commit()
        res.status(201).json({message: 'Purchase order created', purchaseOrderId: purchaseOrder.insertId, poNumber})
    } catch (error) {
        await connection.rollback()
        sendError(res, error)
    } finally {
        connection.release()
    }
})

app.post('/api/purchase-orders/:id/receive', async (req, res) => {
    const connection = await pool.getConnection()
    try {
        await ensureFinancialJournalDueDates()
        const purchaseOrderId = requiredId(req.params.id, 'purchase order id')
        const warehouseId = requiredId(req.body.warehouseId, 'warehouseId')
        const purchaseDueDate = journalDate(req.body.purchaseDueDate, 'purchaseDueDate')
        await connection.beginTransaction()
        const [[purchaseOrder]] = await connection.query(
            `SELECT po.po_number, po.po_date, po.status, s.supplier_name
             FROM purchase_orders po
             JOIN suppliers s ON s.id = po.supplier_id
             WHERE po.id = ? FOR UPDATE`, [purchaseOrderId]
        )
        if (!purchaseOrder) throw new Error('Purchase order not found')
        if (purchaseOrder.status !== 'PENDING') throw new Error('Only pending purchase orders can be received')
        let shelfId = req.body.shelfId ? requiredId(req.body.shelfId, 'shelfId') : null
        if (shelfId) {
            const [[shelf]] = await connection.query('SELECT id FROM shelves WHERE id = ? AND warehouse_id = ?', [shelfId, warehouseId])
            if (!shelf) throw new Error('Shelf does not belong to the selected warehouse')
        } else {
            const [[shelf]] = await connection.query('SELECT id FROM shelves WHERE warehouse_id = ? ORDER BY id LIMIT 1', [warehouseId])
            if (!shelf) throw new Error('The warehouse has no shelf')
            shelfId = shelf.id
        }
        const [items] = await connection.query(
            'SELECT item_id, quantity, unit_cost, production_date FROM purchase_order_items WHERE purchase_order_id = ?', [purchaseOrderId]
        )
        for (const item of items) {
            const addedQty = Number(item.quantity)
            const purchaseCost = Number(item.unit_cost)
            const productionDate = requiredDate(item.production_date, 'production date')
            await recalcAvgCost(connection, item.item_id, addedQty, purchaseCost)
            await addInventory(connection, item.item_id, warehouseId, shelfId, addedQty)
            await addFifoLayer(connection, item.item_id, warehouseId, shelfId, addedQty, purchaseCost, purchaseOrder.po_number, null, productionDate)
            const [transaction] = await connection.query(`
                INSERT INTO inventory_transactions
                (item_id, warehouse_id, shelf_id, transaction_type, quantity, unit_cost, production_date, cogs, reference_number, notes)
                VALUES (?, ?, ?, 'IN', ?, ?, ?, NULL, ?, 'Purchase order received')
            `, [item.item_id, warehouseId, shelfId, addedQty, purchaseCost, productionDate, purchaseOrder.po_number])
            const [[itemDetails]] = await connection.query(`
                SELECT i.item_name, i.item_code, b.brand_name
                FROM items i JOIN brands b ON b.id = i.brand_id
                WHERE i.id = ?
            `, [item.item_id])
            const [[stockAfterReceipt]] = await connection.query(
                'SELECT COALESCE(SUM(quantity), 0) AS quantity FROM inventory WHERE item_id = ?',
                [item.item_id]
            )
            await createAutomaticJournalEntry(connection, {
                orderDate: requiredDate(purchaseOrder.po_date, 'purchase order date'),
                number: purchaseOrder.po_number,
                type: 'PURCHASE',
                name: purchaseOrder.supplier_name,
                quantity: addedQty,
                stockRemaining: Number(stockAfterReceipt.quantity),
                brand: itemDetails.brand_name,
                serialNumber: null,
                purchasePricePerUnit: purchaseCost,
                totalPurchasePrice: addedQty * purchaseCost,
                purchaseDueDate,
                paymentStatus: 'Not recorded',
                remainingDebt: addedQty * purchaseCost,
                sellingPricePerUnit: null,
                totalSellingPrice: null,
                remainingReceivables: null,
                paidStatus: 'Not recorded',
                paidTo: purchaseOrder.supplier_name,
                notes: `Purchase order received: ${itemDetails.item_name}`,
                sourceTransactionId: transaction.insertId
            })
        }
        await connection.query("UPDATE purchase_orders SET status = 'RECEIVED' WHERE id = ?", [purchaseOrderId])
        await connection.commit()
        res.json({message: 'Purchase order received', purchaseOrderId})
    } catch (error) {
        await connection.rollback()
        sendError(res, error)
    } finally {
        connection.release()
    }
})

const journalDecimal = (value, fieldName) => {
    if (value === '' || value == null) return 0
    const number = Number(value)
    if (!Number.isFinite(number)) throw new Error(`${fieldName} must be a valid number`)
    return number
}

const journalDate = (value, fieldName, required = false) => {
    if (!value && !required) return null
    return requiredDate(value, fieldName)
}

const financialJournalDueDateChecks = new Map()

const ensureFinancialJournalDueDates = async () => {
    const [[database]] = await pool.query('SELECT DATABASE() AS databaseName')
    const databaseName = database.databaseName
    let check = financialJournalDueDateChecks.get(databaseName)
    if (!check) {
        check = (async () => {
            const [columns] = await pool.query(`
                SELECT COLUMN_NAME AS columnName
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'financial_journal'
            `)
            const existingColumns = new Set(columns.map((column) => column.columnName))

            // Ensure base table has all required columns safely
            if (!existingColumns.has('purchase_settlement_date')) {
                await pool.query('ALTER TABLE financial_journal ADD COLUMN purchase_settlement_date DATE NULL')
            }
            if (!existingColumns.has('purchase_due_date')) {
                await pool.query('ALTER TABLE financial_journal ADD COLUMN purchase_due_date DATE NULL')
            }
            if (!existingColumns.has('sale_settlement_date')) {
                await pool.query('ALTER TABLE financial_journal ADD COLUMN sale_settlement_date DATE NULL')
            }
            if (!existingColumns.has('sale_due_date')) {
                await pool.query('ALTER TABLE financial_journal ADD COLUMN sale_due_date DATE NULL')
            }
        })()
        financialJournalDueDateChecks.set(databaseName, check)
        check.catch(() => financialJournalDueDateChecks.delete(databaseName))
    }
    await check
}
const createAutomaticJournalEntry = async (connection, entry) => {
    await connection.query(`
        INSERT INTO financial_journal
        (order_date, \`number\`, \`type\`, name, quantity_kg, stock_remaining, brand,
         serial_number, adjustment, purchase_price_per_unit, total_purchase_price,
        purchase_settlement_date, purchase_due_date, remaining_debt, selling_price_per_unit,
        total_selling_price, sale_settlement_date, sale_due_date, payment_status,
         remaining_receivables, paid_status, commission, paid_commission, profit,
         paid_to, notes, source_transaction_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        entry.orderDate, entry.number, entry.type, entry.name, entry.quantity,
        entry.stockRemaining, entry.brand, entry.serialNumber, entry.adjustment || 0,
        entry.purchasePricePerUnit ?? null, entry.totalPurchasePrice ?? null,
        entry.purchaseSettlementDate || null, entry.purchaseDueDate || null, entry.remainingDebt ?? null,
        entry.sellingPricePerUnit ?? null, entry.totalSellingPrice ?? null,
        entry.saleSettlementDate || null, entry.saleDueDate || null, entry.paymentStatus || 'Not recorded',
        entry.remainingReceivables ?? null, entry.paidStatus || 'Not recorded',
        entry.commission || 0, entry.paidCommission || 0, entry.profit || 0,
        entry.paidTo || null, entry.notes || null, entry.sourceTransactionId
    ])
}

const createStockMovementFromFinancialJournal = async (connection, entry) => {
    const type = String(entry.type || '').toUpperCase()
    const stockTypes = ['PURCHASE', 'SALE', 'CUSTOMER_RETURN']
    if (!stockTypes.includes(type)) return null

    const itemId = Number(entry.item_id)
    const warehouseId = Number(entry.warehouse_id)
    const shelfId = Number(entry.shelf_id)
    if (!Number.isInteger(itemId) || itemId <= 0 || !Number.isInteger(warehouseId) || warehouseId <= 0 || !Number.isInteger(shelfId) || shelfId <= 0) {
        throw new Error('item_id, warehouse_id, and shelf_id are required for stock-linked financial journal entries')
    }

    const rawQuantity = Number(entry.quantity_kg ?? 0)
    if (!Number.isFinite(rawQuantity) || rawQuantity === 0) return null

    const quantity = Math.abs(rawQuantity)
    const movementType = type === 'SALE' ? 'OUT' : 'IN'
    const [[stock]] = await connection.query(
        'SELECT quantity FROM inventory WHERE item_id = ? AND warehouse_id = ? AND shelf_id = ? FOR UPDATE',
        [itemId, warehouseId, shelfId]
    )
    if (movementType === 'OUT' && (!stock || Number(stock.quantity) < quantity)) {
        throw new Error('Insufficient stock for this financial journal sale')
    }

    const unitCostSource = Number(entry.purchase_price_per_unit ?? 0)
    const totalPriceSource = Number(entry.total_purchase_price ?? 0)
    const unitCost = unitCostSource > 0 ? unitCostSource : totalPriceSource > 0 ? totalPriceSource / quantity : 0
    const costingMethod = String(entry.costing_method || 'WAC').toUpperCase()
    let avgCost = 0
    let fifo = null

    if (movementType === 'IN') {
        avgCost = await recalcAvgCost(connection, itemId, quantity, unitCost)
        await addFifoLayer(connection, itemId, warehouseId, shelfId, quantity, unitCost, entry.reference || `JNL-${Date.now()}`, null, entry.production_date || null)
    } else if (movementType === 'OUT') {
        if (costingMethod === 'FIFO') {
            fifo = await consumeFifoLayers(connection, itemId, warehouseId, shelfId, quantity, true, true)
        } else {
            ({avgCost} = await getItemCost(connection, itemId))
        }
    }

    await addInventory(connection, itemId, warehouseId, shelfId, movementType === 'OUT' ? -quantity : quantity)

    const cogs = movementType === 'OUT' && costingMethod === 'WAC' ? avgCost * quantity : null
    const reference = entry.reference || `JNL-${Date.now()}`
    const totalSellingPrice = Number(entry.total_selling_price || 0)
    const saleUnitPrice = movementType === 'OUT'
        ? Number(entry.selling_price_per_unit ?? (totalSellingPrice > 0 ? totalSellingPrice / quantity : 0))
        : null
    const taxPct = movementType === 'OUT' ? Number(entry.tax_pct || 0) : null
    const discountAmount = movementType === 'OUT' ? Number(entry.discount_amount || 0) : null
    const notes = entry.notes || 'Financial journal stock sync'

    const [transaction] = await connection.query(`
        INSERT INTO inventory_transactions
        (item_id, warehouse_id, shelf_id, transaction_type, quantity, unit_cost, cogs, fifo_cogs, fifo_layers, costing_method,
         customer_name, sale_price, tax_pct, discount_amount, production_date, reference_number, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        itemId, warehouseId, shelfId, movementType, quantity,
        movementType === 'IN' ? unitCost : (movementType === 'OUT' && costingMethod === 'WAC' ? avgCost : null),
        cogs,
        movementType === 'OUT' && costingMethod === 'FIFO' ? fifo?.fifoCogs ?? null : null,
        movementType === 'OUT' && costingMethod === 'FIFO' ? fifo?.breakdown ?? null : null,
        costingMethod,
        entry.name || null,
        saleUnitPrice,
        taxPct,
        discountAmount,
        entry.production_date || null,
        reference,
        notes
    ])

    return transaction.insertId
}

app.get('/financial-journal/download.csv', async (req, res) => {
    try {
        const [entries, fields] = await pool.query(
            'SELECT * FROM financial_journal ORDER BY order_date DESC, id DESC'
        )
        const header = fields.map((field) => csvCell(field.name)).join(',')
        const rows = entries.map((entry) => fields.map((field) => csvCell(entry[field.name])).join(','))
        const csv = [header, ...rows].join('\r\n')
        res.attachment(`financial-journal-${new Date().toISOString().slice(0, 10)}.csv`)
        res.type('text/csv; charset=utf-8').send(`\uFEFF${csv}`)
    } catch (error) {
        console.error(error)
        res.status(500).send('Unable to download the financial journal')
    }
})

app.get('/financial-journal', async (req, res) => {
    try {
        await ensureFinancialJournalDueDates()
        const [[entries], [brands], [items], [warehouses], [shelves], [[summary]], [[stockSummary]], [importSummaryRows]] = await Promise.all([
            pool.query(`
            SELECT id, DATE_FORMAT(order_date, '%Y-%m-%d') AS order_date, \`number\`, \`type\`, name, quantity_kg, quantity_in_kg,
                   quantity_out_kg, stock_remaining,
                   brand, serial_number, adjustment, purchase_price_per_unit,
                   total_purchase_price, purchase_amount_paid,
                   DATE_FORMAT(purchase_settlement_date, '%Y-%m-%d') AS purchase_settlement_date,
                   DATE_FORMAT(purchase_due_date, '%Y-%m-%d') AS purchase_due_date, remaining_debt,
                   selling_price_per_unit, total_selling_price, sale_amount_received,
                   DATE_FORMAT(sale_settlement_date, '%Y-%m-%d') AS sale_settlement_date,
                   DATE_FORMAT(sale_due_date, '%Y-%m-%d') AS sale_due_date,
                   payment_status, remaining_receivables, paid_status, commission,
                   commission_paid_status, paid_commission, profit, paid_to, notes, import_reference,
                   CASE
                       WHEN \`type\` IN ('PURCHASE', 'CUSTOMER_RETURN') THEN total_purchase_price
                       WHEN \`type\` = 'SALE' THEN total_selling_price
                       WHEN total_purchase_price > 0 THEN total_purchase_price
                       WHEN total_selling_price > 0 THEN total_selling_price
                       ELSE 0
                   END AS payment_total,
                   CASE
                       WHEN \`type\` IN ('PURCHASE', 'CUSTOMER_RETURN') THEN COALESCE(remaining_debt, 0)
                       WHEN \`type\` = 'SALE' THEN COALESCE(remaining_receivables, 0)
                       WHEN total_purchase_price > 0 THEN COALESCE(remaining_debt, 0)
                       WHEN total_selling_price > 0 THEN COALESCE(remaining_receivables, 0)
                       ELSE 0
                   END AS outstanding_amount
            FROM financial_journal
            ORDER BY order_date DESC, id DESC
            `),
            pool.query('SELECT brand_name FROM brands ORDER BY brand_name'),
            pool.query(`
                SELECT i.id, i.item_name, i.item_code, b.brand_name
                FROM items i
                JOIN brands b ON b.id = i.brand_id
                ORDER BY i.item_name
            `),
            pool.query('SELECT id, warehouse_name FROM warehouse ORDER BY warehouse_name'),
            pool.query('SELECT id, warehouse_id, shelf_code FROM shelves ORDER BY warehouse_id, shelf_code'),
            pool.query(`
                SELECT COUNT(*) AS entry_count,
                       COALESCE(SUM(quantity_kg), 0) AS net_quantity,
                       COALESCE(SUM(total_purchase_price), 0) AS total_purchases,
                       COALESCE(SUM(total_selling_price), 0) AS total_sales,
                       COALESCE(SUM(remaining_debt), 0) AS outstanding_debt,
                       COALESCE(SUM(remaining_receivables), 0) AS outstanding_receivables,
                       COALESCE(SUM(profit), 0) AS total_profit
                FROM financial_journal
            `),
            pool.query(`
                SELECT COALESCE(SUM(quantity), 0) AS total_stock
                FROM inventory
            `),
            pool.query(`
                SELECT source_id, DATE_FORMAT(as_of_date, '%Y-%m-%d') AS as_of_date,
                       row_count, totals, balances
                FROM financial_journal_import_summaries
                ORDER BY as_of_date DESC, source_id
            `)
        ])
        const paymentEntries = entries.filter((entry) => Number(entry.outstanding_amount) > 0)
        const sourceSummaries = importSummaryRows.map((source) => {
            const totals = typeof source.totals === 'string' ? JSON.parse(source.totals) : source.totals
            const balances = typeof source.balances === 'string' ? JSON.parse(source.balances) : source.balances
            const totalValues = [
                {label: 'Quantity in (kg)', value: totals.quantity_in_kg, currency: false},
                {label: 'Quantity out (kg)', value: totals.quantity_out_kg, currency: false},
                {label: 'Net quantity (kg)', value: totals.net_quantity_kg, currency: false},
                {label: 'Adjustments', value: totals.adjustment, currency: true},
                {label: 'Total purchases', value: totals.total_purchase_price, currency: true},
                {label: 'Purchases paid (source total)', value: totals.purchase_amount_paid, currency: true},
                {label: 'Remaining debt (source total)', value: totals.remaining_debt, currency: true},
                {label: 'Total sales', value: totals.total_selling_price, currency: true},
                {label: 'Sales received', value: totals.sale_amount_received, currency: true},
                {label: 'Remaining receivables', value: totals.remaining_receivables, currency: true},
                {label: 'Commission paid', value: totals.commission_paid, currency: true},
                {label: 'Commission unpaid', value: totals.commission_unpaid, currency: true},
                {label: 'Profit', value: totals.profit, currency: true}
            ]
            const totalRows = []
            for (let index = 0; index < totalValues.length; index += 2) {
                totalRows.push(totalValues.slice(index, index + 2))
            }
            return {
                ...source,
                totalRows,
                accounts: Object.entries(balances.accounts).map(([name, value]) => ({name, value})),
                accountTotalsAsOf: balances.account_totals_as_of,
                debtToBisun: balances.debt_to_Bisun
            }
        })
        res.render('financial-journal', {entries, brands, items, warehouses, shelves, paymentEntries, summary, stockSummary, sourceSummaries})
    } catch (error) {
        sendServerError(res, error)
    }
})

app.get('/api/payment-reminders', async (req, res) => {
    try {
        await ensureFinancialJournalDueDates()
        const [reminders] = await pool.query(`
            SELECT id, \`number\`, name,
                   CASE WHEN COALESCE(remaining_debt, 0) > 0 THEN 'Pay' ELSE 'Collect' END AS action,
                   CASE WHEN COALESCE(remaining_debt, 0) > 0 THEN COALESCE(remaining_debt, 0)
                        ELSE COALESCE(remaining_receivables, 0) END AS amount,
                   DATE_FORMAT(CASE WHEN COALESCE(remaining_debt, 0) > 0 THEN purchase_due_date
                                    ELSE sale_due_date END, '%Y-%m-%d') AS dueDate,
                   CASE WHEN (COALESCE(remaining_debt, 0) > 0 AND purchase_due_date < CURRENT_DATE())
                          OR (COALESCE(remaining_receivables, 0) > 0 AND sale_due_date < CURRENT_DATE())
                        THEN 'Overdue' ELSE 'Due today' END AS timing
            FROM financial_journal
            WHERE (COALESCE(remaining_debt, 0) > 0 AND purchase_due_date <= CURRENT_DATE())
               OR (COALESCE(remaining_receivables, 0) > 0 AND sale_due_date <= CURRENT_DATE())
            ORDER BY dueDate, id
            LIMIT 50
        `)
        res.json({reminders})
    } catch (error) {
        sendError(res, error)
    }
})

app.patch('/api/financial-journal/:id/payment', async (req, res) => {
    const connection = await pool.getConnection()
    try {
        const journalId = requiredId(req.params.id, 'journal id')
        const amountPaid = positiveNumber(req.body.amountPaid, 'amountPaid')
        const settlementDate = journalDate(req.body.settlementDate, 'settlementDate') || new Date().toISOString().slice(0, 10)
        await connection.beginTransaction()
        const [[entry]] = await connection.query(`
            SELECT id, \`type\`, total_purchase_price, total_selling_price,
                   remaining_debt, remaining_receivables, payment_status, paid_status
            FROM financial_journal
            WHERE id = ?
            FOR UPDATE
        `, [journalId])
        if (!entry) throw new Error('Financial journal entry not found')
        const isPurchase = ['PURCHASE', 'CUSTOMER_RETURN'].includes(String(entry.type).toUpperCase())
            || (Number(entry.total_purchase_price) > 0 && Number(entry.total_selling_price) === 0)
        const isSale = String(entry.type).toUpperCase() === 'SALE'
            || (Number(entry.total_selling_price) > 0 && Number(entry.total_purchase_price) === 0)
        if (!isPurchase && !isSale) throw new Error('This journal entry has no payable or receivable amount to settle')
        const currentOutstanding = isPurchase
            ? Number(entry.remaining_debt || 0)
            : Number(entry.remaining_receivables || 0)
        if (amountPaid > currentOutstanding) throw new Error('Payment amount cannot exceed the remaining balance')
        const remaining = Math.max(0, currentOutstanding - amountPaid)
        const status = remaining === 0 ? 'Paid' : 'Partially paid'
        if (isPurchase) {
            await connection.query(`
                UPDATE financial_journal
                SET remaining_debt = ?, payment_status = ?, paid_status = ?, purchase_settlement_date = ?,
                    purchase_amount_paid = COALESCE(purchase_amount_paid, 0) + ?
                WHERE id = ?
            `, [remaining, status, status, settlementDate, amountPaid, journalId])
        } else {
            await connection.query(`
                UPDATE financial_journal
                SET remaining_receivables = ?, payment_status = ?, paid_status = ?, sale_settlement_date = ?,
                    sale_amount_received = COALESCE(sale_amount_received, 0) + ?
                WHERE id = ?
            `, [remaining, status, status, settlementDate, amountPaid, journalId])
        }
        await connection.commit()
        res.json({message: `Payment recorded. Status: ${status}`, status, outstandingAmount: remaining})
    } catch (error) {
        await connection.rollback()
        sendError(res, error)
    } finally {
        connection.release()
    }
})

app.post('/api/financial-journal', async (req, res) => {
    const connection = await pool.getConnection()
    try {
        await ensureFinancialJournalDueDates()
        const body = req.body
        const orderDate = journalDate(body.order_date, 'order_date', true)
        const number = requiredText(body.number, 'number')
        const type = requiredText(body.type, 'type').toUpperCase()
        if (!['PURCHASE', 'SALE', 'CUSTOMER_RETURN', 'ADJUSTMENT', 'TRANSFER'].includes(type)) {
            throw new Error('type must be a supported journal entry type')
        }
        const name = requiredText(body.name, 'name')
        const allowedStatuses = ['Not recorded', 'Not applicable', 'Unpaid', 'Partially paid', 'Paid']
        const paymentStatus = String(body.payment_status || '').trim()
        const paidStatus = String(body.paid_status || '').trim()
        if (paymentStatus && !allowedStatuses.includes(paymentStatus)) throw new Error('payment_status is not supported')
        if (paidStatus && !allowedStatuses.includes(paidStatus)) throw new Error('paid_status is not supported')

        await connection.beginTransaction()

        const itemId = body.item_id ?? body.itemId ?? null
        const warehouseId = body.warehouse_id ?? body.warehouseId ?? null
        const shelfId = body.shelf_id ?? body.shelfId ?? null
        const costingMethod = String(body.costing_method || body.costingMethod || 'WAC').toUpperCase()
        let sourceTransactionId = null

        if (['PURCHASE', 'SALE', 'CUSTOMER_RETURN'].includes(type)) {
            sourceTransactionId = await createStockMovementFromFinancialJournal(connection, {
                ...body,
                type,
                item_id: itemId,
                warehouse_id: warehouseId,
                shelf_id: shelfId,
                costing_method: costingMethod,
                reference: `${number}-${Date.now()}`,
                production_date: body.production_date || body.productionDate || null,
                quantity_kg: body.quantity_kg,
                notes: body.notes
            })
        }

        const values = [
            orderDate, number, type, name,
            journalDecimal(body.quantity_kg, 'quantity_kg'),
            journalDecimal(body.stock_remaining, 'stock_remaining'),
            String(body.brand || '').trim() || null,
            String(body.serial_number || '').trim() || null,
            journalDecimal(body.adjustment, 'adjustment'),
            journalDecimal(body.purchase_price_per_unit, 'purchase_price_per_unit'),
            journalDecimal(body.total_purchase_price, 'total_purchase_price'),
            journalDate(body.purchase_settlement_date, 'purchase_settlement_date'),
            journalDate(body.purchase_due_date, 'purchase_due_date'),
            journalDecimal(body.remaining_debt, 'remaining_debt'),
            journalDecimal(body.selling_price_per_unit, 'selling_price_per_unit'),
            journalDecimal(body.total_selling_price, 'total_selling_price'),
            journalDate(body.sale_settlement_date, 'sale_settlement_date'),
            journalDate(body.sale_due_date, 'sale_due_date'),
            paymentStatus || null,
            journalDecimal(body.remaining_receivables, 'remaining_receivables'),
            paidStatus || null,
            journalDecimal(body.commission, 'commission'),
            journalDecimal(body.paid_commission, 'paid_commission'),
            journalDecimal(body.profit, 'profit'),
            String(body.paid_to || '').trim() || null,
            String(body.notes || '').trim() || null,
            sourceTransactionId
        ]
        await connection.query(`
            INSERT INTO financial_journal
            (order_date, \`number\`, \`type\`, name, quantity_kg, stock_remaining, brand,
             serial_number, adjustment, purchase_price_per_unit, total_purchase_price,
             purchase_settlement_date, purchase_due_date, remaining_debt, selling_price_per_unit,
             total_selling_price, sale_settlement_date, sale_due_date, payment_status,
             remaining_receivables, paid_status, commission, paid_commission, profit,
             paid_to, notes, source_transaction_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, values)
        await connection.commit()
        res.status(201).json({message: sourceTransactionId ? 'Financial journal entry saved and stock movement synchronized' : 'Financial journal entry saved', sourceTransactionId})
    } catch (error) {
        await connection.rollback()
        sendError(res, error)
    } finally {
        connection.release()
    }
})

app.post('/api/transactions', async (req, res) => {
    const connection = await pool.getConnection()
    try {
        await ensureFinancialJournalDueDates()
        const type = String(req.body.type || '').toUpperCase()
        if (!['BUY', 'SELL', 'PURCHASE'].includes(type)) throw new Error('type must be BUY, SELL, or PURCHASE')
        const itemId = requiredId(req.body.itemId, 'itemId')
        const warehouseId = requiredId(req.body.warehouseId, 'warehouseId')
        const shelfId = requiredId(req.body.shelfId, 'shelfId')
        const quantity = positiveNumber(req.body.quantity, 'quantity')
        const isPurchase = type === 'PURCHASE'
        const isSale = type === 'SELL'
        const costingMethod = isSale ? String(req.body.costingMethod || '').toUpperCase() : null
        if (isSale && !['WAC', 'FIFO'].includes(costingMethod)) {
            throw new Error('Choose WAC or FIFO as the costing method for this sale')
        }
        const counterpartyName = requiredText(req.body.customerName, isPurchase ? 'supplierName' : 'customerName')
        const purchaseUnitCost = isPurchase ? positiveNumber(req.body.purchaseUnitCost, 'purchaseUnitCost') : 0
        const returnUnitCost = type === 'BUY' ? positiveNumber(req.body.returnUnitCost, 'returnUnitCost') : 0
        const productionDate = isPurchase ? requiredDate(req.body.productionDate, 'productionDate') : null
        const salePrice = isSale ? positiveNumber(req.body.salePrice, 'salePrice') : 0
        const taxPct = isSale ? Number(req.body.taxPct || 0) : 0
        const discountAmount = isSale ? Number(req.body.discountAmount || 0) : 0
        if (!Number.isFinite(taxPct) || taxPct < 0) throw new Error('taxPct must be zero or greater')
        if (!Number.isFinite(discountAmount) || discountAmount < 0) throw new Error('discountAmount must be zero or greater')
        const amountPaid = journalDecimal(req.body.amountPaid, 'amountPaid')
        if (amountPaid < 0) throw new Error('amountPaid must be zero or greater')
        const purchaseSettlementDate = isPurchase || type === 'BUY'
            ? journalDate(req.body.purchaseSettlementDate, 'purchaseSettlementDate')
            : null
        const purchaseDueDate = isPurchase || type === 'BUY'
            ? journalDate(req.body.purchaseDueDate, 'purchaseDueDate')
            : null
        const saleSettlementDate = isSale
            ? journalDate(req.body.saleSettlementDate, 'saleSettlementDate')
            : null
        const saleDueDate = isSale
            ? journalDate(req.body.saleDueDate, 'saleDueDate')
            : null
        const commission = isSale ? journalDecimal(req.body.commission, 'commission') : 0
        const paidCommission = isSale ? journalDecimal(req.body.paidCommission, 'paidCommission') : 0
        if (commission < 0 || paidCommission < 0 || paidCommission > commission) {
            throw new Error('Commission amounts must be non-negative and paid commission cannot exceed commission')
        }
        await connection.beginTransaction()
        const [[stock]] = await connection.query(`
            SELECT quantity FROM inventory
            WHERE item_id = ? AND warehouse_id = ? AND shelf_id = ? FOR UPDATE
        `, [itemId, warehouseId, shelfId])
        if (isSale && (!stock || Number(stock.quantity) < quantity)) throw new Error('Insufficient stock for this sale')
        const newQuantity = isSale ? quantity * -1 : quantity
        let avgCost = 0
        if (isPurchase || type === 'BUY') {
            avgCost = await recalcAvgCost(connection, itemId, quantity, isPurchase ? purchaseUnitCost : returnUnitCost)
        } else if (isSale && costingMethod === 'WAC') {
            ({avgCost} = await getItemCost(connection, itemId))
        }
        const reference = req.body.referenceNumber || makeNumber(type)
        const fifo = isSale
            ? await consumeFifoLayers(
                connection,
                itemId,
                warehouseId,
                shelfId,
                quantity,
                costingMethod === 'FIFO',
                costingMethod === 'FIFO'
            )
            : null
        await addInventory(connection, itemId, warehouseId, shelfId, newQuantity)
        if (isPurchase) {
            await addFifoLayer(connection, itemId, warehouseId, shelfId, quantity, purchaseUnitCost, reference, null, productionDate)
        } else if (type === 'BUY') {
            await addFifoLayer(connection, itemId, warehouseId, shelfId, quantity, returnUnitCost, reference)
        }
        const notes = [req.body.notes || '']
            .filter(Boolean).join(' | ') || null
        const cogs = isSale && costingMethod === 'WAC' ? avgCost * quantity : null
        const selectedCogs = costingMethod === 'FIFO' ? fifo.fifoCogs : cogs
        const subtotal = quantity * salePrice
        if (isSale && discountAmount > subtotal) throw new Error('discountAmount cannot exceed the sale subtotal')
        const totalDue = isPurchase || type === 'BUY'
            ? quantity * (isPurchase ? purchaseUnitCost : returnUnitCost)
            : isSale
                ? subtotal - discountAmount + (subtotal - discountAmount) * taxPct / 100
                : 0
        if (amountPaid > totalDue) throw new Error('amountPaid cannot exceed the transaction total')
        const paymentStatus = amountPaid === 0
                ? 'Unpaid'
                : amountPaid >= totalDue
                    ? 'Paid'
                    : 'Partially paid'
        const transactionType = isSale ? 'OUT' : 'IN'
        const [transaction] = await connection.query(`
            INSERT INTO inventory_transactions
            (item_id, warehouse_id, shelf_id, transaction_type, quantity, unit_cost, cogs, fifo_cogs, fifo_layers, costing_method,
             customer_name, sale_price, tax_pct, discount_amount, production_date, reference_number, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            itemId, warehouseId, shelfId, transactionType, quantity,
            isPurchase ? purchaseUnitCost : type === 'BUY' ? returnUnitCost : costingMethod === 'WAC' ? avgCost || null : null,
            cogs, costingMethod === 'FIFO' ? fifo.fifoCogs : null,
            costingMethod === 'FIFO' ? fifo.breakdown : null, costingMethod, counterpartyName,
            isSale ? salePrice : null, isSale ? taxPct : null, isSale ? discountAmount : null,
            productionDate || (fifo ? fifo.productionDate : null), reference, notes
        ])
        const [[itemDetails]] = await connection.query(`
            SELECT i.item_name, i.item_code, b.brand_name
            FROM items i JOIN brands b ON b.id = i.brand_id
            WHERE i.id = ?
        `, [itemId])
        const [[stockAfterTransaction]] = await connection.query(
            'SELECT COALESCE(SUM(quantity), 0) AS quantity FROM inventory WHERE item_id = ?',
            [itemId]
        )
        const totalSellingPrice = isSale
            ? totalDue
            : type === 'BUY'
                ? -(quantity * salePrice)
                : 0
        const profit = isSale
            ? subtotal - discountAmount - selectedCogs - commission
            : 0
        await createAutomaticJournalEntry(connection, {
            orderDate: new Date(),
            number: reference,
            type: isPurchase ? 'PURCHASE' : isSale ? 'SALE' : 'CUSTOMER_RETURN',
            name: counterpartyName,
            quantity: isSale ? -quantity : quantity,
            stockRemaining: Number(stockAfterTransaction.quantity),
            brand: itemDetails.brand_name,
            serialNumber: String(req.body.serialNumber || '').trim() || null,
            adjustment: isSale ? discountAmount : 0,
            purchasePricePerUnit: isSale ? null : isPurchase ? purchaseUnitCost : returnUnitCost,
            totalPurchasePrice: isSale ? null : isPurchase ? quantity * purchaseUnitCost : quantity * returnUnitCost,
            purchaseSettlementDate: isSale ? null : purchaseSettlementDate,
            purchaseDueDate: isSale ? null : purchaseDueDate,
            remainingDebt: isPurchase || type === 'BUY' ? Math.max(0, totalDue - amountPaid) : null,
            sellingPricePerUnit: isPurchase ? null : isSale ? salePrice : null,
            totalSellingPrice: isPurchase ? null : isSale ? totalSellingPrice : null,
            saleSettlementDate: isPurchase || type === 'BUY' ? null : saleSettlementDate,
            saleDueDate: isPurchase || type === 'BUY' ? null : saleDueDate,
            paymentStatus,
            remainingReceivables: isSale ? Math.max(0, totalDue - amountPaid) : null,
            paidStatus: paymentStatus,
            commission,
            paidCommission,
            profit,
            paidTo: isPurchase || type === 'BUY' ? counterpartyName : null,
            notes: [notes, costingMethod ? `COGS method ${costingMethod}` : null, `Stock transaction ${reference}`]
                .filter(Boolean).join(' | '),
            costingMethod,
            sourceTransactionId: transaction.insertId
        })
        await connection.commit()
        res.status(201).json({message: `Stock ${isPurchase ? 'purchase' : type === 'BUY' ? 'return' : 'sale'} recorded and journal updated`, reference, transactionId: transaction.insertId})
    } catch (error) {
        await connection.rollback()
        sendError(res, error)
    } finally {
        connection.release()
    }
})

app.get('/api/item-costs', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT i.id, i.item_name, i.item_code,
                   COALESCE(ic.avg_cost, 0)   AS avg_cost,
                   COALESCE(ic.markup_pct, 30) AS markup_pct,
                   ROUND(COALESCE(ic.avg_cost, 0) * (1 + COALESCE(ic.markup_pct, 30) / 100), 4) AS suggested_price
            FROM items i
            LEFT JOIN item_costs ic ON ic.item_id = i.id
            ORDER BY i.item_name
        `)
        res.json(rows)
    } catch (error) {
        sendError(res, error)
    }
})

app.patch('/api/item-costs/:itemId', requireWorkspaceRoles('owner', 'admin'), async (req, res) => {
    try {
        const itemId = requiredId(req.params.itemId, 'itemId')
        const markupPct = Number(req.body.markupPct)
        if (!Number.isFinite(markupPct) || markupPct < 0) throw new Error('markupPct must be zero or greater')
        await pool.query(
            `INSERT INTO item_costs (item_id, markup_pct) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE markup_pct = VALUES(markup_pct), updated_at = CURRENT_TIMESTAMP`,
            [itemId, markupPct]
        )
        res.json({message: 'Markup updated'})
    } catch (error) {
        sendError(res, error)
    }
})

app.get('/api/inventory/stock', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT inv.item_id, inv.warehouse_id, inv.shelf_id, inv.quantity,
                   w.warehouse_name, s.shelf_code
            FROM inventory inv
            JOIN warehouse w ON w.id = inv.warehouse_id
            JOIN shelves s ON s.id = inv.shelf_id
            WHERE inv.quantity > 0
        `)
        res.json(rows)
    } catch (error) {
        sendError(res, error)
    }
})

const getCommonLookups = async () => {
    const [[items], [warehouses], [shelves], [suppliers], [brands], [units]] = await Promise.all([
        pool.query(`
            SELECT i.id, i.item_name, i.item_code, b.brand_name
            FROM items i
            JOIN brands b ON b.id = i.brand_id
            ORDER BY i.item_name
        `),
        pool.query('SELECT id, warehouse_name FROM warehouse ORDER BY warehouse_name'),
        pool.query('SELECT id, warehouse_id, shelf_code FROM shelves ORDER BY warehouse_id, shelf_code'),
        pool.query('SELECT id, supplier_name FROM suppliers ORDER BY supplier_name'),
        pool.query('SELECT id, brand_name FROM brands ORDER BY brand_name'),
        pool.query('SELECT id, unit_name FROM units ORDER BY unit_name')
    ])
    let itemCosts = []
    try {
        const [rows] = await pool.query(`
            SELECT i.id AS item_id, i.item_name, i.item_code,
                   COALESCE(ic.avg_cost, 0)    AS avg_cost,
                   COALESCE(ic.markup_pct, 30) AS markup_pct,
                   ROUND(COALESCE(ic.avg_cost, 0) * (1 + COALESCE(ic.markup_pct, 30) / 100), 4) AS suggested_price
            FROM items i
            LEFT JOIN item_costs ic ON ic.item_id = i.id
            ORDER BY i.item_name
        `)
        itemCosts = rows
    } catch (_) {}
    return {items, warehouses, shelves, suppliers, brands, units, itemCosts}
}

app.get('/stock-transactions', async (req, res) => {
    try {
        const lookups = await getCommonLookups()
        const [transactions] = await pool.query(`
            SELECT t.*, i.item_name, w.warehouse_name, s.shelf_code
            FROM inventory_transactions t
            JOIN items i ON i.id = t.item_id
            JOIN warehouse w ON w.id = t.warehouse_id
            JOIN shelves s ON s.id = t.shelf_id
            ORDER BY t.created_at DESC LIMIT 100
        `)
        const [inventoryStock] = await pool.query(`
            SELECT inv.item_id, inv.warehouse_id, inv.shelf_id, inv.quantity,
                   w.warehouse_name, s.shelf_code
            FROM inventory inv
            JOIN warehouse w ON w.id = inv.warehouse_id
            JOIN shelves s ON s.id = inv.shelf_id
            WHERE inv.quantity > 0
        `)
        const [fifoLayers] = await pool.query(`
            SELECT item_id, warehouse_id, shelf_id, remaining_quantity, unit_cost, received_at, id
            FROM inventory_cost_layers
            WHERE remaining_quantity > 0
            ORDER BY received_at, id
        `)
        res.render('stock-transactions', {
            ...lookups,
            transactions,
            inventoryStockJson: JSON.stringify(inventoryStock),
            fifoLayersJson: JSON.stringify(fifoLayers),
            allWarehousesJson: JSON.stringify(lookups.warehouses),
            allShelvesJson: JSON.stringify(lookups.shelves)
        })
    } catch (error) {
        sendServerError(res, error)
    }
})

app.get('/item-details/:id', async (req, res) => {
    try {
        const itemId = requiredId(req.params.id, 'item id')
        const [[item]] = await pool.query(`
            SELECT i.id, i.item_name, i.item_code, i.description, i.minimum_stock,
                   i.created_at AS registered_at, b.brand_name, u.unit_name,
                   COALESCE(ic.avg_cost, 0) AS avg_cost,
                   COALESCE(ic.markup_pct, 30) AS markup_pct
            FROM items i
            JOIN brands b ON b.id = i.brand_id
            JOIN units u ON u.id = i.unit_id
            LEFT JOIN item_costs ic ON ic.item_id = i.id
            WHERE i.id = ?
        `, [itemId])
        if (!item) return res.status(404).send('Item not found')
        const [[stock]] = await pool.query(`
            SELECT COALESCE(SUM(quantity), 0) AS quantity
            FROM inventory WHERE item_id = ?
        `, [itemId])
        const [layers] = await pool.query(`
            SELECT l.remaining_quantity, l.unit_cost, l.production_date, l.received_at,
                   w.warehouse_name, s.shelf_code
            FROM inventory_cost_layers l
            JOIN warehouse w ON w.id = l.warehouse_id
            JOIN shelves s ON s.id = l.shelf_id
            WHERE l.item_id = ? AND l.remaining_quantity > 0
            ORDER BY l.production_date, l.received_at, l.id
        `, [itemId])
        const [purchases] = await pool.query(`
            SELECT po.po_number, po.po_date, poi.quantity, poi.unit_cost, poi.production_date,
                   po.created_at AS registered_at, sp.supplier_name
            FROM purchase_order_items poi
            JOIN purchase_orders po ON po.id = poi.purchase_order_id
            JOIN suppliers sp ON sp.id = po.supplier_id
            WHERE poi.item_id = ?
            ORDER BY po.po_date DESC, poi.id DESC
        `, [itemId])
        res.render('item-details', {item, stock, layers, purchases})
    } catch (error) {
        res.status(400).send(error.message)
    }
})

const getInvoiceData = async (transactionId) => {
    const [[invoice]] = await pool.query(`
        SELECT t.id, t.created_at AS registered_at, t.customer_name, t.quantity,
               t.sale_price, t.tax_pct, t.discount_amount, t.production_date,
               t.reference_number, i.item_name, i.item_code, u.unit_name,
               b.brand_name
        FROM inventory_transactions t
        JOIN items i ON i.id = t.item_id
        JOIN brands b ON b.id = i.brand_id
        JOIN units u ON u.id = i.unit_id
        WHERE t.id = ? AND t.transaction_type = 'OUT'
    `, [transactionId])
    if (!invoice) return null
    const subtotal = Number(invoice.quantity) * Number(invoice.sale_price || 0)
    const discount = Number(invoice.discount_amount || 0)
    const taxable = Math.max(0, subtotal - discount)
    const tax = taxable * Number(invoice.tax_pct || 0) / 100
    return {invoice, subtotal, discount, tax, total: taxable + tax}
}

app.get('/invoice/:id/download', async (req, res) => {
    try {
        const transactionId = requiredId(req.params.id, 'transaction id')
        const invoiceData = await getInvoiceData(transactionId)
        if (!invoiceData) return res.status(404).send('Sale invoice not found')

        const {invoice, subtotal, discount, tax, total} = invoiceData
        const document = new PDFDocument({size: 'A4', margin: 48})
        res.attachment(`invoice-${invoice.id}.pdf`)
        res.type('application/pdf')
        document.pipe(res)

        const money = (amount) => formatWorkspaceCurrency(amount, req.workspacePreferences)
        const left = document.page.margins.left
        const right = document.page.width - document.page.margins.right
        document.fillColor('#176b4a').font('Helvetica-Bold').fontSize(13).text('StockFlow')
        document.moveDown(1)
        document.fillColor('#15231f').fontSize(26).text('INVOICE')
        document.moveDown(0.5)
        document.font('Helvetica').fontSize(10)
        document.text(`Invoice: ${invoice.reference_number || invoice.id}`)
        document.text(`Date: ${invoice.registered_at ? new Date(invoice.registered_at).toLocaleDateString('id-ID') : '-'}`)
        document.moveDown(0.5)
        document.font('Helvetica-Bold').text('Customer')
        document.font('Helvetica').text(invoice.customer_name || '-')
        document.moveDown(1.5)
        const rowY = document.y
        document.moveTo(left, rowY).lineTo(right, rowY).stroke('#176b4a')
        document.moveDown(0.6)
        document.font('Helvetica-Bold').text('Item', left, document.y, {continued: true})
        document.text('Quantity', {align: 'right'})
        document.font('Helvetica').text(`${invoice.item_name} (${invoice.item_code})`, left, document.y, {continued: true})
        document.text(`${invoice.quantity} ${invoice.unit_name || ''}`, {align: 'right'})
        document.text(`Brand: ${invoice.brand_name || '-'} | Production date: ${invoice.production_date || '-'}`)
        document.moveDown(1)
        document.text(`Unit price: ${money(invoice.sale_price)}`, {align: 'right'})
        document.text(`Subtotal: ${money(subtotal)}`, {align: 'right'})
        document.text(`Discount: -${money(discount)}`, {align: 'right'})
        document.text(`Tax (${Number(invoice.tax_pct || 0)}%): ${money(tax)}`, {align: 'right'})
        document.moveTo(left, document.y + 4).lineTo(right, document.y + 4).stroke('#15231f')
        document.moveDown(0.6)
        document.font('Helvetica-Bold').fontSize(14).text(`Total: ${money(total)}`, {align: 'right'})
        document.end()
    } catch (error) {
        if (res.headersSent) return res.destroy(error)
        res.status(400).send(error.message)
    }
})

app.get('/invoice/:id', async (req, res) => {
    try {
        const transactionId = requiredId(req.params.id, 'transaction id')
        const invoiceData = await getInvoiceData(transactionId)
        if (!invoiceData) return res.status(404).send('Sale invoice not found')
        res.render('invoice', invoiceData)
    } catch (error) {
        res.status(400).send(error.message)
    }
})

app.get('/stock-report', async (req, res) => {
    try {
        const selectedMethod = String(req.query.method || 'WAC').toUpperCase()
        if (!['WAC', 'FIFO'].includes(selectedMethod)) {
            return res.status(400).send('method must be WAC or FIFO')
        }
        const [[summary]] = await pool.query(`
            SELECT COUNT(DISTINCT item_id) AS item_count,
                   COUNT(DISTINCT warehouse_id) AS warehouse_count,
                   COALESCE(SUM(quantity), 0) AS total_stock,
                   COALESCE(SUM(CASE WHEN quantity <= 0 THEN 1 ELSE 0 END), 0) AS empty_locations
            FROM inventory
        `)
        const [byWarehouse] = await pool.query(`
            SELECT w.warehouse_name, COALESCE(SUM(inv.quantity), 0) AS quantity
            FROM warehouse w LEFT JOIN inventory inv ON inv.warehouse_id = w.id
            GROUP BY w.id, w.warehouse_name ORDER BY quantity DESC
        `)
        const [byItem] = await pool.query(`
            SELECT i.id, i.item_name, i.item_code, i.minimum_stock,
                   COALESCE(SUM(inv.quantity), 0) AS quantity,
                   COALESCE(ic.avg_cost, 0)        AS avg_cost,
                   COALESCE(ic.markup_pct, 30)     AS markup_pct,
                   ROUND(COALESCE(ic.avg_cost, 0) * (1 + COALESCE(ic.markup_pct, 30) / 100), 4) AS suggested_price,
                   COALESCE(fl.fifo_avg_cost, 0) AS fifo_avg_cost
            FROM items i
            LEFT JOIN inventory inv ON inv.item_id = i.id
            LEFT JOIN item_costs  ic  ON ic.item_id  = i.id
            LEFT JOIN (
                SELECT item_id, SUM(remaining_quantity * unit_cost) / NULLIF(SUM(remaining_quantity), 0) AS fifo_avg_cost
                FROM inventory_cost_layers
                WHERE remaining_quantity > 0
                GROUP BY item_id
            ) fl ON fl.item_id = i.id
            GROUP BY i.id, i.item_name, i.item_code, i.minimum_stock, ic.avg_cost, ic.markup_pct
                     , fl.fifo_avg_cost
            ORDER BY quantity DESC
        `)
        let movement
        try {
            const [[row]] = await pool.query(`
                SELECT COALESCE(SUM(CASE WHEN transaction_type = 'IN'  THEN quantity ELSE 0 END), 0) AS stock_in,
                       COALESCE(SUM(CASE WHEN transaction_type = 'OUT' THEN quantity ELSE 0 END), 0) AS stock_out,
                       COALESCE(SUM(CASE WHEN transaction_type = 'OUT'
                           AND (costing_method IS NULL OR costing_method = 'WAC')
                           THEN cogs ELSE 0 END), 0) AS total_cogs,
                       COALESCE(SUM(CASE WHEN transaction_type = 'OUT'
                           AND (costing_method IS NULL OR costing_method = 'FIFO')
                           THEN fifo_cogs ELSE 0 END), 0) AS total_fifo_cogs,
                       COALESCE(SUM(CASE WHEN t.transaction_type = 'OUT'
                           AND (t.costing_method IS NULL OR t.costing_method = 'WAC')
                           THEN (t.quantity * COALESCE(t.sale_price, 0))
                               - COALESCE(t.discount_amount, 0) - COALESCE(t.cogs, 0)
                           ELSE 0 END), 0) AS gross_profit_wac,
                       COALESCE(SUM(CASE WHEN t.transaction_type = 'OUT'
                           AND (t.costing_method IS NULL OR t.costing_method = 'FIFO')
                           THEN (t.quantity * COALESCE(t.sale_price, 0))
                               - COALESCE(t.discount_amount, 0) - COALESCE(t.fifo_cogs, 0)
                           ELSE 0 END), 0) AS gross_profit_fifo,
                       COUNT(*) AS movement_count
                FROM inventory_transactions t
                JOIN items i ON i.id = t.item_id
            `)
            movement = row
        } catch (_) {
            const [[row]] = await pool.query(`
                SELECT COALESCE(SUM(CASE WHEN transaction_type = 'IN'  THEN quantity ELSE 0 END), 0) AS stock_in,
                       COALESCE(SUM(CASE WHEN transaction_type = 'OUT' THEN quantity ELSE 0 END), 0) AS stock_out,
                       0 AS total_cogs,
                       0 AS total_fifo_cogs,
                       0 AS gross_profit_wac,
                       0 AS gross_profit_fifo,
                       COUNT(*) AS movement_count
                FROM inventory_transactions
            `)
            movement = row
        }
        const maximum = Math.max(...byWarehouse.map((row) => Number(row.quantity)), 1)
        const itemMaximum = Math.max(...byItem.map((row) => Number(row.quantity)), 1)
        movement.selected_cogs = Number(selectedMethod === 'WAC' ? movement.total_cogs : movement.total_fifo_cogs)
        movement.selected_gross_profit = Number(selectedMethod === 'WAC'
            ? movement.gross_profit_wac
            : movement.gross_profit_fifo)
        byWarehouse.forEach((row) => row.width = Math.round(Number(row.quantity) / maximum * 100))
        byItem.forEach((row) => {
            row.width = Math.round(Number(row.quantity) / itemMaximum * 100)
            row.low_stock = Number(row.quantity) <= Number(row.minimum_stock)
            row.report_cost = Number(selectedMethod === 'WAC' ? row.avg_cost : row.fifo_avg_cost)
            row.report_suggested_price = row.report_cost * (1 + Number(row.markup_pct) / 100)
        })
        res.render('stock-report', {summary, byWarehouse, byItem, movement, selectedMethod})
    } catch (error) {
        sendServerError(res, error)
    }
})

app.post('/api/reset-operational-data', requireWorkspaceRoles('owner'), async (req, res) => {
    const connection = await pool.getConnection()
    try {
        await connection.beginTransaction()
        await connection.query('DELETE FROM financial_journal WHERE source_transaction_id IS NOT NULL')
        await connection.query('DELETE FROM inventory_transactions')
        await connection.query('DELETE FROM inventory_cost_layers')
        await connection.query('DELETE FROM stock_transfer_items')
        await connection.query('DELETE FROM stock_transfers')
        await connection.query('DELETE FROM purchase_order_items')
        await connection.query('DELETE FROM purchase_orders')
        await connection.query('DELETE FROM inventory')
        await connection.query('DELETE FROM item_costs')
        await connection.commit()
        res.json({message: 'Operational data reset. Master data was preserved.'})
    } catch (error) {
        await connection.rollback()
        sendError(res, error)
    } finally {
        connection.release()
    }
})

app.get('/transfers', async (req, res) => {
    try {
        const {items, warehouses} = await getCommonLookups()
        const [transfers] = await pool.query(`
            SELECT st.*, fw.warehouse_name AS from_warehouse, tw.warehouse_name AS to_warehouse
            FROM stock_transfers st JOIN warehouse fw ON fw.id = st.from_warehouse_id
            JOIN warehouse tw ON tw.id = st.to_warehouse_id ORDER BY st.created_at DESC
        `)
        res.render('transfers', {items, warehouses, transfers})
    } catch (error) {
        sendServerError(res, error)
    }
})

app.get('/purchase-orders', async (req, res) => {
    try {
        await ensurePreOrdersTable()
        const {items, warehouses, shelves, suppliers} = await getCommonLookups()
        const [purchaseOrders] = await pool.query(`
            SELECT po.id, po.po_number, po.po_date, po.status, s.supplier_name,
                   COALESCE(SUM(poi.quantity * poi.unit_cost), 0) AS total
            FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
            LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
            GROUP BY po.id, s.supplier_name ORDER BY po.created_at DESC
        `)
        const [preOrders] = await pool.query(`
            SELECT po.*, i.item_name, i.item_code, b.brand_name,
                   (po.quantity * po.unit_price) AS total_value
            FROM pre_orders po
            JOIN items i ON i.id = po.item_id
            JOIN brands b ON b.id = i.brand_id
            ORDER BY po.created_at DESC
        `)
        const [[summary]] = await pool.query(`
            SELECT
                COALESCE(SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pending,
                COALESCE(SUM(CASE WHEN status = 'FULFILLED' THEN 1 ELSE 0 END), 0) AS fulfilled,
                COALESCE(SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END), 0) AS cancelled
            FROM pre_orders
        `)
        res.render('purchase-orders', {
            items, warehouses, shelves, suppliers, purchaseOrders, preOrders,
            summary: summary || {pending: 0, fulfilled: 0, cancelled: 0}
        })
    } catch (error) {
        sendServerError(res, error)
    }
})

const ensurePreOrdersTable = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pre_orders (
            id INT AUTO_INCREMENT PRIMARY KEY,
            item_id INT NOT NULL,
            customer_name VARCHAR(255) NOT NULL,
            quantity DECIMAL(15,3) NOT NULL,
            unit_price DECIMAL(15,2) NOT NULL DEFAULT 0,
            status ENUM('PENDING','FULFILLED','CANCELLED') NOT NULL DEFAULT 'PENDING',
            order_date DATE NOT NULL,
            expected_date DATE NULL,
            notes VARCHAR(255) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (item_id) REFERENCES items(id)
        )
    `)
}

const ensureWorkspaceOnboardingTable = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS workspace_onboarding (
            id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
            status ENUM('active', 'skipped', 'completed') NOT NULL DEFAULT 'active',
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    await pool.query("INSERT IGNORE INTO workspace_onboarding (id, status) VALUES (1, 'active')")
}

app.get('/pre-orders', async (req, res) => {
    res.redirect('/purchase-orders#pre-orders')
})

app.post('/api/pre-orders', async (req, res) => {
    try {
        await ensurePreOrdersTable()
        const itemId = requiredId(req.body.itemId, 'itemId')
        const customerName = requiredText(req.body.customerName, 'customerName')
        const quantity = positiveNumber(req.body.quantity, 'quantity')
        const unitPrice = positiveNumber(req.body.unitPrice, 'unitPrice')
        const orderDate = requiredDate(req.body.orderDate || new Date(), 'orderDate')
        const expectedDate = req.body.expectedDate ? requiredDate(req.body.expectedDate, 'expectedDate') : null
        const notes = String(req.body.notes || '').trim()

        const [result] = await pool.query(`
            INSERT INTO pre_orders (item_id, customer_name, quantity, unit_price, status, order_date, expected_date, notes)
            VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?)
        `, [itemId, customerName, quantity, unitPrice, orderDate, expectedDate, notes || null])

        res.status(201).json({message: 'Pre-order created', preOrderId: result.insertId})
    } catch (error) {
        sendError(res, error)
    }
})

app.patch('/api/pre-orders/:id/status', async (req, res) => {
    try {
        await ensurePreOrdersTable()
        const preOrderId = requiredId(req.params.id, 'preOrderId')
        const status = String(req.body.status || '').trim().toUpperCase()
        const validStatuses = ['PENDING', 'FULFILLED', 'CANCELLED']
        if (!validStatuses.includes(status)) {
            throw new Error('Status must be PENDING, FULFILLED, or CANCELLED.')
        }

        await pool.query('UPDATE pre_orders SET status = ? WHERE id = ?', [status, preOrderId])
        res.json({message: `Pre-order marked as ${status.toLowerCase()}.`})
    } catch (error) {
        sendError(res, error)
    }
})

app.get('/master-data', requireWorkspaceRoles('owner', 'admin'), async (req, res) => {
    try {
        const {items, warehouses, shelves, suppliers, brands, units, itemCosts} = await getCommonLookups()
        res.render('master-data', {items, warehouses, shelves, suppliers, brands, units, itemCosts})
    } catch (error) {
        sendServerError(res, error)
    }
})

app.post('/api/warehouses', requireWorkspaceRoles('owner', 'admin'), async (req, res) => {
    const connection = await pool.getConnection()
    try {
        const warehouseName = requiredText(req.body.warehouseName, 'warehouseName')
        const address = requiredText(req.body.address, 'address')
        const shelfCode = requiredText(req.body.shelfCode || 'MAIN', 'shelfCode')
        const shelfBlock = requiredText(req.body.shelfBlock || 'MAIN', 'shelfBlock')
        await connection.beginTransaction()
        const [warehouse] = await connection.query(`
            INSERT INTO warehouse (warehouse_name, address, contact, contact_name, codes, email, image)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [warehouseName, address, req.body.codes || null,  req.body.image || null])
        await connection.query(
            'INSERT INTO shelves (warehouse_id, shelf_code, shelf_block) VALUES (?, ?, ?)',
            [warehouse.insertId, shelfCode, shelfBlock]
        )
        await connection.commit()
        res.status(201).json({message: 'Warehouse created', warehouseId: warehouse.insertId})
    } catch (error) {
        await connection.rollback()
        sendError(res, error)
    } finally {
        connection.release()
    }
})

app.post('/api/shelves', requireWorkspaceRoles('owner', 'admin'), async (req, res) => {
    try {
        const warehouseId = requiredId(req.body.warehouseId, 'warehouseId')
        const shelfCode = requiredText(req.body.shelfCode, 'shelfCode')
        const shelfBlock = requiredText(req.body.shelfBlock, 'shelfBlock')
        const [result] = await pool.query(
            'INSERT INTO shelves (warehouse_id, shelf_code, shelf_block) VALUES (?, ?, ?)',
            [warehouseId, shelfCode, shelfBlock]
        )
        res.status(201).json({message: 'Shelf created', shelfId: result.insertId})
    } catch (error) {
        sendError(res, error)
    }
})

app.post('/api/brands', requireWorkspaceRoles('owner', 'admin'), async (req, res) => {
    try {
        const brandName = requiredText(req.body.brandName, 'brandName')
        const description = requiredText(req.body.description, 'description')
        const [result] = await pool.query(
            'INSERT INTO brands (brand_name, brand_description) VALUES (?, ?)',
            [brandName, description]
        )
        res.status(201).json({message: 'Brand created', brandId: result.insertId})
    } catch (error) {
        sendError(res, error)
    }
})

app.post('/api/units', requireWorkspaceRoles('owner', 'admin'), async (req, res) => {
    try {
        const unitName = requiredText(req.body.unitName, 'unitName')
        const description = requiredText(req.body.description, 'description')
        const [result] = await pool.query(
            'INSERT INTO units (unit_name, descriptions) VALUES (?, ?)',
            [unitName, description]
        )
        res.status(201).json({message: 'Unit created', unitId: result.insertId})
    } catch (error) {
        sendError(res, error)
    }
})

app.post('/api/items', requireWorkspaceRoles('owner', 'admin'), async (req, res) => {
    try {
        const itemName = requiredText(req.body.itemName, 'itemName')
        const itemCode = requiredText(req.body.itemCode, 'itemCode')
        const brandId = requiredId(req.body.brandId, 'brandId')
        const unitId = requiredId(req.body.unitId, 'unitId')
        const minimumStock = req.body.minimumStock === '' || req.body.minimumStock == null
            ? 0
            : Number(req.body.minimumStock)
        if (!Number.isFinite(minimumStock) || minimumStock < 0) throw new Error('minimumStock must be zero or greater')
        const [result] = await pool.query(`
            INSERT INTO items (brand_id, unit_id, item_name, item_code, description, minimum_stock)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [brandId, unitId, itemName, itemCode, req.body.description || null, minimumStock])
        res.status(201).json({message: 'Item created', itemId: result.insertId})
    } catch (error) {
        sendError(res, error)
    }
})

app.post('/api/suppliers', requireWorkspaceRoles('owner', 'admin'), async (req, res) => {
    try {
        const supplierName = requiredText(req.body.supplierName, 'supplierName')
        const [result] = await pool.query(`
            INSERT INTO suppliers (supplier_name, contact, email, address)
            VALUES (?, ?, ?, ?)
        `, [supplierName, req.body.contact || null, req.body.email || null, req.body.address || null])
        res.status(201).json({message: 'Supplier created', supplierId: result.insertId})
    } catch (error) {
        sendError(res, error)
    }
})

let workspaceBackupRunInProgress = false

const runScheduledWorkspaceBackups = async () => {
    if (workspaceBackupRunInProgress || !process.env.BACKUP_ENCRYPTION_KEY) return
    workspaceBackupRunInProgress = true
    try {
        getBackupEncryptionKey()
        const [workspaces] = await runWithBaseDatabase(() => pool.query(`
            SELECT DISTINCT database_name
            FROM app_user_workspaces
            WHERE is_active = TRUE
            ORDER BY database_name
        `))
        for (const workspace of workspaces) {
            try {
                await createEncryptedWorkspaceBackup(workspace.database_name)
            } catch (error) {
                console.error(`Scheduled backup failed for workspace ${workspace.database_name}:`, error)
            }
        }
    } finally {
        workspaceBackupRunInProgress = false
    }
}

const startServer = async () => {
    console.log("STARTING SERVER INITIALIZATION...");
    console.log("Database Host:", process.env.MYSQL_HOST);
    console.log("Running DB setup queries...");
    await pool.query(`
        CREATE TABLE IF NOT EXISTS app_users (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(32) NOT NULL UNIQUE,
            email VARCHAR(254) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS app_workspace (
            id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
            owner_user_id BIGINT UNSIGNED NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_app_workspace_owner
                FOREIGN KEY (owner_user_id) REFERENCES app_users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS app_user_workspaces (
            user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
            database_name VARCHAR(64) NOT NULL,
            role ENUM('owner', 'admin', 'staff') NOT NULL DEFAULT 'owner',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_app_user_workspaces_database_name (database_name),
            CONSTRAINT fk_app_user_workspaces_user
                FOREIGN KEY (user_id) REFERENCES app_users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    const [workspaceColumns] = await pool.query(`
        SELECT COLUMN_NAME AS columnName
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'app_user_workspaces'
    `)
    const existingWorkspaceColumns = new Set(workspaceColumns.map((column) => column.columnName))
    if (!existingWorkspaceColumns.has('role')) {
        await pool.query("ALTER TABLE app_user_workspaces ADD COLUMN role ENUM('owner', 'admin', 'staff') NOT NULL DEFAULT 'owner' AFTER database_name")
    }
    if (!existingWorkspaceColumns.has('is_active')) {
        await pool.query('ALTER TABLE app_user_workspaces ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE AFTER role')
    }
    const [uniqueDatabaseIndexes] = await pool.query(`
        SELECT DISTINCT INDEX_NAME AS indexName
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'app_user_workspaces'
          AND COLUMN_NAME = 'database_name' AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY'
    `)
    for (const index of uniqueDatabaseIndexes) {
        const indexName = String(index.indexName).replace(/`/g, '``')
        await pool.query(`ALTER TABLE app_user_workspaces DROP INDEX \`${indexName}\``)
    }
    const [workspaceDatabaseIndexes] = await pool.query(`
        SELECT INDEX_NAME AS indexName
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'app_user_workspaces'
          AND COLUMN_NAME = 'database_name' AND INDEX_NAME = 'idx_app_user_workspaces_database_name'
    `)
    if (!workspaceDatabaseIndexes.length) {
        await pool.query('CREATE INDEX idx_app_user_workspaces_database_name ON app_user_workspaces (database_name)')
    }
    await pool.query(`
        CREATE TABLE IF NOT EXISTS app_workspace_invites (
            token_hash CHAR(64) NOT NULL PRIMARY KEY,
            database_name VARCHAR(64) NOT NULL,
            role ENUM('admin', 'staff') NOT NULL,
            created_by BIGINT UNSIGNED NOT NULL,
            expires_at DATETIME NOT NULL,
            accepted_by BIGINT UNSIGNED NULL,
            accepted_at DATETIME NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_app_workspace_invites_database_name (database_name),
            CONSTRAINT fk_app_workspace_invites_creator
                FOREIGN KEY (created_by) REFERENCES app_users(id),
            CONSTRAINT fk_app_workspace_invites_accepted_user
                FOREIGN KEY (accepted_by) REFERENCES app_users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    const [[existingWorkspace]] = await pool.query('SELECT owner_user_id FROM app_workspace WHERE id = 1')
    if (!existingWorkspace) {
        const [[lina]] = await pool.query('SELECT id FROM app_users WHERE username = ?', ['lina'])
        if (lina) {
            await pool.query('INSERT INTO app_workspace (id, owner_user_id) VALUES (1, ?)', [lina.id])
        }
    }
    const [[workspace]] = await pool.query('SELECT owner_user_id FROM app_workspace WHERE id = 1')
    workspaceOwnerId = workspace?.owner_user_id ? Number(workspace.owner_user_id) : null
    await sessionStore.onReady()

    const PORT = Number(process.env.PORT) || 3003;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on port ${PORT}`);
        if (process.env.BACKUP_ENCRYPTION_KEY) {
            runScheduledWorkspaceBackups().catch((error) => console.error('Scheduled workspace backup failed:', error))
            const backupTimer = setInterval(() => {
                runScheduledWorkspaceBackups().catch((error) => console.error('Scheduled workspace backup failed:', error))
            }, 24 * 60 * 60 * 1000)
            backupTimer.unref()
        }
    })
}

startServer().catch((error) => {
    console.error('Unable to initialize authentication storage:', error)
    process.exit(1)
})