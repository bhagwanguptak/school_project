// server.js

// --- Core Dependencies ---
const dotenv = require('dotenv');
const path = require('path');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const { URL } = require('url');

// --- New Database & Session Dependencies ---
const { Pool } = require('pg');
const { createClient } = require('redis');
const RedisStore = require('connect-redis').default;

// --- File Upload & Blob Storage Dependencies ---
const multerLib = require('multer');
const { put, del, head } = require('@vercel/blob');

// --- Initializations ---
const app = express(); // Define app instance globally
const saltRounds = 10;
const multer = multerLib({ storage: multerLib.memoryStorage() });

let mailTransporter;
let db; // Will be initialized in setupApplication
let redisClient; // Will be initialized in setupApplication
let redisStore; // Will be initialized in setupApplication

// --- Main Application Setup Function ---
async function setupApplication() {
    // --- Environment Variable Loading (for local development) ---
    const envConfig = dotenv.config({ path: path.resolve(__dirname, 'variables.env') });
    if (envConfig.error) {
        if (envConfig.error.code === 'ENOENT' && process.env.NODE_ENV === 'production') {
            console.log('variables.env not found (expected in production, using Vercel ENV VARS).');
        } else if (envConfig.error.code === 'ENOENT') {
            console.warn('Warning: variables.env file not found for local dev. Using system ENV VARS or code defaults.');
        } else {
            console.warn('Warning: Could not load variables.env file. Error:', envConfig.error);
        }
    } else if (process.env.NODE_ENV !== 'production'){
        console.log('Successfully loaded variables from variables.env for local development.');
    }
    console.log(`Current NODE_ENV: ${process.env.NODE_ENV}`);
    console.log(`SESSION_SECRET defined: ${!!process.env.SESSION_SECRET}`);
    console.log(`KV_URL defined: ${!!process.env.KV_URL}`);
    console.log(`POSTGRES_URL defined: ${!!process.env.POSTGRES_URL}`);
    console.log(`FRONTEND_URL defined: ${process.env.FRONTEND_URL || 'Not Set (Required for CORS in Prod)'}`);

    // --- Vercel Postgres Database Setup ---
    let dbConnectionString = process.env.POSTGRES_URL;
    if (dbConnectionString) {
        try {
            const dbUrl = new URL(dbConnectionString);
            if (dbUrl.searchParams.has('sslmode')) {
                dbUrl.searchParams.delete('sslmode');
                dbConnectionString = dbUrl.toString();
                console.log('Removed conflicting sslmode from POSTGRES_URL.');
            }
        } catch (e) {
            console.error('Could not parse POSTGRES_URL, using it as is.', e.message);
        }
    } else {
        console.error("FATAL: POSTGRES_URL environment variable is not set!");
    }

    db = new Pool({ // Assign to global db
        connectionString: dbConnectionString,
        ssl: { rejectUnauthorized: false }
    });
    db.on('connect', () => console.log('Connected to Vercel Postgres database.'));
    db.on('error', (err) => console.error('Postgres Pool Error:', err));


    // --- Vercel KV (Redis) Session Store Setup ---
    if (process.env.KV_URL) {
        redisClient = createClient({ url: process.env.KV_URL }); // Assign to global redisClient

        redisClient.on('connect', () => console.log('Redis client: attempting to connect...'));
        redisClient.on('ready', () => console.log('Redis client: connection established and ready.'));
        redisClient.on('end', () => console.log('Redis client: connection closed.'));
        redisClient.on('reconnecting', () => console.log('Redis client: attempting to reconnect...'));
        redisClient.on('error', err => console.error('Redis Client Error:', err));

        try {
            await redisClient.connect(); // AWAIT the connection
            console.log('Redis client successfully connected via await.');
            redisStore = new RedisStore({ client: redisClient }); // Assign to global redisStore
            console.log('RedisStore initialized after await.');
        } catch (err) {
            console.error('Redis client .connect() FAILED during await:', err);
            console.error('WARNING: Sessions will likely not work if Redis connection failed.');
        }
    } else {
        console.error("FATAL: KV_URL environment variable is not set! Redis session store cannot be configured.");
    }

    // --- Nodemailer Setup ---
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
        mailTransporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || "587"),
            secure: process.env.SMTP_SECURE === 'true',
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        try {
            await mailTransporter.verify();
            console.log("Nodemailer: Server is ready to take our messages.");
        } catch (error) {
            console.warn("Nodemailer: Error configuring mail transporter. Email sending will fail.", error.message);
        }
    } else {
        console.warn("Nodemailer: SMTP environment variables not fully set. Email sending will be disabled.");
    }

    // --- Middlewares ---
    // 1. Body Parsers
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // 2. CORS
    const allowedOrigins = [];
    if (process.env.FRONTEND_URL) {
        allowedOrigins.push(process.env.FRONTEND_URL);
    }
    if (process.env.NODE_ENV !== 'production') {
        allowedOrigins.push('http://localhost:5173');
        allowedOrigins.push('http://localhost:3000');
    }
    console.log("CORS: Allowed Origins ->", allowedOrigins);

    app.use(cors({
        origin: function (origin, callback) {
            if (!origin || allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                console.warn(`CORS: Blocked origin -> ${origin}`);
                callback(new Error(`Origin '${origin}' not allowed by CORS`));
            }
        },
        credentials: true
    }));

    // 3. Session Configuration (NOW redisStore should be ready or undefined if connection failed)
    if (redisStore) {
        app.use(session({
            store: redisStore,
            secret: process.env.SESSION_SECRET || 'fallback_super_secret_key_please_change_in_env_vars_for_prod',
            resave: false,
            saveUninitialized: false,
            cookie: {
                secure: process.env.NODE_ENV === 'production',
                httpOnly: true,
                maxAge: 24 * 60 * 60 * 1000,
                sameSite: process.env.NODE_ENV === 'production' ? 'lax' : 'lax'
            }
        }));
        console.log("Session middleware configured with RedisStore.");
    } else {
        console.warn("Session middleware NOT configured (redisStore not initialized or Redis connection failed). Requests requiring session will fail.");
    }

    // 4. Static Files
    app.use(express.static(path.join(__dirname, 'public')));
    app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

    // --- Database Table Initialization ---
    await initializeDatabase(); // Ensure this function is defined and handles db connection check

    // --- Authentication Middleware (checkAuth) ---
    function checkAuth(req, res, next) {
        console.log(`CheckAuth: Path=${req.originalUrl}, SessionID=${req.sessionID}`);
        console.log(`CheckAuth: Full req.session ->`, req.session);

        if (req.session && req.session.authenticated) {
            console.log(`CheckAuth: User '${req.session.username}' IS authenticated.`);
            return next();
        }
        
        console.log(`CheckAuth: User NOT authenticated. SessionID=${req.sessionID}, Session exists=${!!req.session}, Authenticated flag=${req.session ? req.session.authenticated : 'N/A'}`);
        if (req.originalUrl.startsWith('/api/')) {
            return res.status(401).json({ error: 'Unauthorized. Please log in.', redirectTo: '/login.html?unauthorized=true' });
        }
        res.redirect('/login.html?unauthorized=true');
    }

    // --- HTML Serving Routes ---
    app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'school.html')));
    app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
    app.get('/admin', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
    app.get('/school', (req, res) => res.sendFile(path.join(__dirname, 'public', 'school.html')));

    // --- Authentication API Routes ---
    app.post('/login', async (req, res) => {
        const { username, password: plainTextPassword } = req.body;
        if (!username || !plainTextPassword) {
            return res.status(400).redirect('/login.html?error=' + encodeURIComponent('Username and password are required.'));
        }
        if (!req.session) {
            console.error("LOGIN ABORTED: req.session is not defined. Session middleware might not be configured or running correctly (Redis issue?).");
            return res.status(500).redirect('/login.html?error=Server+session+configuration+error');
        }
        try {
            const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
            const user = result.rows[0];

            if (user) {
                const match = await bcrypt.compare(plainTextPassword, user.password);
                if (match) {
                    req.session.regenerate((regenErr) => {
                        if (regenErr) {
                            console.error("Session regeneration error:", regenErr);
                            return res.status(500).redirect('/login.html?error=Session+error');
                        }
                        req.session.authenticated = true;
                        req.session.username = user.username;
                        console.log(`LOGIN: User '${user.username}' credentials valid. Session data set. Session ID: ${req.sessionID}. Attempting to save...`);
                        req.session.save((saveErr) => {
                            if (saveErr) {
                                console.error("LOGIN > CRITICAL: Error saving session to Redis after login:", saveErr);
                                return res.status(500).redirect('/login.html?error=Session+save+error');
                            }
                            console.log(`LOGIN > SUCCESS: Session SAVED for '${user.username}'. Session ID: ${req.sessionID}. Redirecting to /admin.html.`);
                            res.redirect('/admin.html');
                        });
                    });
                } else {
                    console.log(`Login failed for username '${username}' (password mismatch).`);
                    res.status(401).redirect('/login.html?error=Invalid+credentials');
                }
            } else {
                console.log(`Login failed for username '${username}' (user not found).`);
                res.status(401).redirect('/login.html?error=Invalid+credentials');
            }
        } catch (err) {
            console.error("Login DB error:", err);
            res.status(500).redirect('/login.html?error=Server+error');
        }
    });

    app.post('/api/logout', (req, res) => {
        if (req.session) {
            const username = req.session.username || 'unknown user';
            console.log(`Attempting to logout user: ${username}, Session ID: ${req.sessionID}`);
            req.session.destroy(err => {
                if (err) {
                    console.error(`Error destroying session during logout for ${username}:`, err);
                    return res.status(500).json({ message: "Logout failed due to server error." });
                }
                res.clearCookie('connect.sid', { path: '/' });
                console.log(`User ${username} logged out successfully. Session destroyed, cookie cleared.`);
                return res.status(200).json({ message: 'Logout successful' });
            });
        } else {
            console.log('Logout request received, but no active session found.');
            res.status(200).json({ message: 'No active session to log out from.' });
        }
    });

    // --- Settings API ---
    app.get('/api/settings', async (req, res) => {
        try {
            const result = await db.query('SELECT setting_name, setting_value FROM settings');
            const settings = {};
            const jsonKeys = ['socialLinks', 'facilityCards', 'heroGradient', 'aboutGradient', 'admissionsGradient', 'academicsGradient', 'facilitiesGradient', 'contactGradient'];
            result.rows.forEach(row => {
                let value = row.setting_value;
                if (jsonKeys.includes(row.setting_name)) {
                    try {
                        value = value ? JSON.parse(value) : (row.setting_name === 'facilityCards' ? [] : {});
                    } catch (e) {
                        console.warn(`Could not parse setting '${row.setting_name}' as JSON. Value: "${row.setting_value}". Error:`, e.message);
                        value = (row.setting_name === 'facilityCards' ? [] : {}); // Fallback
                    }
                }
                settings[row.setting_name] = value;
            });
            res.json(settings);
        } catch (err) {
            console.error("GET /api/settings DB error:", err.message);
            res.status(500).json({ error: 'Failed to retrieve settings from database.' });
        }
    });

    app.post('/api/settings', checkAuth, async (req, res) => {
        const { settings } = req.body;
        console.log(`/api/settings POST request by user: ${req.session.username}`);
        if (!settings || typeof settings !== 'object') {
            return res.status(400).json({ error: "Missing or invalid 'settings' object." });
        }
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            const sql = 'INSERT INTO settings (setting_name, setting_value) VALUES ($1, $2) ON CONFLICT (setting_name) DO UPDATE SET setting_value = EXCLUDED.setting_value';
            for (const [key, value] of Object.entries(settings)) {
                let valueToStore = (typeof value === 'object' && value !== null) ? JSON.stringify(value) : String(value || '');
                await client.query(sql, [key, valueToStore]);
            }
            await client.query('COMMIT');
            res.json({ message: 'Settings saved successfully' });
        } catch (err) {
            await client.query('ROLLBACK');
            console.error("Error saving settings:", err.message, err.stack);
            res.status(500).json({ error: 'Failed to save settings.' });
        } finally {
            client.release();
        }
    });

    // --- Vercel Blob File Handling ---
    const generateBlobFilename = (originalName) => {
      const timestamp = Date.now();
      const randomString = Math.random().toString(36).substring(2, 8);
      const ext = path.extname(originalName);
      const basename = path.basename(originalName, ext).substring(0, 50).replace(/[^a-zA-Z0-9_.-]/g, '_');
      return `school_assets/images/${basename}-${timestamp}-${randomString}${ext}`;
    };

    const createUploadHandler = (entityName) => async (req, res) => {
        if (!req.file) return res.status(400).json({ message: `No ${entityName} file provided.` });
        console.log(`/api/upload-${entityName.toLowerCase().replace(' ','')} request by user: ${req.session.username}`);
        try {
            const blobFilename = generateBlobFilename(req.file.originalname);
            const blob = await put(blobFilename, req.file.buffer, { access: 'public', contentType: req.file.mimetype });
            console.log(`${entityName} uploaded to Vercel Blob: ${blob.url}`);
            res.json({ message: `${entityName} uploaded successfully to Vercel Blob.`, url: blob.url });
        } catch (error) {
            console.error(`Error uploading ${entityName} to Vercel Blob:`, error);
            res.status(500).json({ message: `Failed to upload ${entityName}.`, error: error.message });
        }
    };

    app.post('/api/upload-logo', checkAuth, multer.single('logo'), createUploadHandler('Logo'));
    app.post('/api/upload-about-image', checkAuth, multer.single('aboutImage'), createUploadHandler('About image'));
    app.post('/api/upload-academics-image', checkAuth, multer.single('academicsImage'), createUploadHandler('Academics image'));

    // --- Carousel API Endpoints ---
    app.get('/api/carousel', async (req, res) => {
        try {
            const result = await db.query('SELECT id, image_url, link_url, alt_text, file_name, display_order FROM carousel_images ORDER BY display_order ASC, id ASC');
            res.json(result.rows);
        } catch (err) {
            console.error("GET /api/carousel error:", err.message);
            res.status(500).json({ error: "Failed to retrieve carousel images." });
        }
    });

    app.post('/api/carousel', checkAuth, multer.single('carouselImage'), async (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No carousel image file uploaded.' });
        console.log(`/api/carousel POST request by user: ${req.session.username}`);
        const { linkURL, altText } = req.body;
        const originalFileName = req.file.originalname;
        try {
            const blobFilename = generateBlobFilename(req.file.originalname);
            const blob = await put(blobFilename, req.file.buffer, { access: 'public', contentType: req.file.mimetype });
            const imageUrl = blob.url;
            console.log(`Carousel image uploaded to Vercel Blob: ${imageUrl}`);
            const sql = `INSERT INTO carousel_images (image_url, link_url, alt_text, file_name, display_order) VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(display_order), 0) + 1 FROM carousel_images)) RETURNING *`;
            const result = await db.query(sql, [imageUrl, linkURL || null, altText || 'Carousel Image', originalFileName]);
            res.status(201).json({ message: 'Carousel image added successfully.', image: result.rows[0] });
        } catch (error) {
            console.error("Error uploading carousel image or saving to DB:", error);
            res.status(500).json({ error: "Failed to add carousel image.", details: error.message });
        }
    });

    app.delete('/api/carousel/:id', checkAuth, async (req, res) => {
        const imageId = parseInt(req.params.id, 10);
        if (isNaN(imageId)) return res.status(400).json({ error: 'Invalid image ID.' });
        console.log(`/api/carousel DELETE id=${imageId} request by user: ${req.session.username}`);
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            const findResult = await client.query('SELECT image_url FROM carousel_images WHERE id = $1', [imageId]);
            if (findResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Image not found in database.' });
            }
            const imageUrlToDelete = findResult.rows[0].image_url;
            const deleteResult = await client.query('DELETE FROM carousel_images WHERE id = $1', [imageId]);
            if (deleteResult.rowCount === 0) throw new Error('Image found but could not be deleted from database.');

            if (imageUrlToDelete && imageUrlToDelete.startsWith('http')) {
                try {
                    await head(imageUrlToDelete); // Check if exists
                    await del(imageUrlToDelete);
                    console.log(`Successfully deleted from Vercel Blob: ${imageUrlToDelete}`);
                } catch (blobError) {
                    if (blobError.status === 404 || (blobError.message && blobError.message.includes('404'))) {
                        console.warn(`Blob not found on Vercel Blob (already deleted?): ${imageUrlToDelete}`);
                    } else {
                        console.error(`Error interacting with Vercel Blob for ${imageUrlToDelete}:`, blobError);
                    }
                }
            } else {
                 console.log(`Skipping Vercel Blob deletion for ID ${imageId} as image_url is not valid: ${imageUrlToDelete}`);
            }
            await client.query('COMMIT');
            res.json({ message: 'Carousel image deletion processed.' });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error("Error during carousel image deletion process:", error);
            res.status(500).json({ error: 'Failed to process image deletion.', details: error.message });
        } finally {
            client.release();
        }
    });

    // --- CONTACT FORM SUBMISSION API ---
    app.post('/api/submit-contact', async (req, res) => {
        const { contactName, contactEmail, contactSubject, contactMessage } = req.body;
        if (!contactName || !contactEmail || !contactSubject || !contactMessage) {
            return res.status(400).json({ success: false, message: "All fields are required." });
        }
        let settings = {};
        try {
            const result = await db.query("SELECT setting_name, setting_value FROM settings WHERE setting_name IN ('contactFormAction', 'schoolContactEmail', 'adminSchoolWhatsappNumber')");
            result.rows.forEach(row => { settings[row.setting_name] = row.setting_value; });
        } catch (dbError) {
            console.error("Error fetching contact settings from DB:", dbError.message);
        }
        const contactFormAction = settings.contactFormAction || process.env.CONTACT_FORM_ACTION_DEFAULT || 'whatsapp';
        if (contactFormAction === 'whatsapp') {
            const whatsAppNumber = settings.adminSchoolWhatsappNumber || process.env.SCHOOL_WHATSAPP_NUMBER;
            if (!whatsAppNumber) {
                console.error("WhatsApp number not configured for contact form.");
                return res.status(500).json({ success: false, message: "Server error: WhatsApp number not set." });
            }
            const whatsappMessageBody = `New Contact Form Submission:\nName: ${contactName}\nEmail: ${contactEmail}\nSubject: ${contactSubject}\nMessage:\n${contactMessage}`;
            const whatsappUrl = `https://wa.me/${whatsAppNumber.replace(/\D/g, '')}?text=${encodeURIComponent(whatsappMessageBody)}`;
            return res.json({ success: true, action: 'whatsapp', whatsappUrl: whatsappUrl, message: "Please click 'Send' in WhatsApp." });
        } 
        if (contactFormAction === 'email') {
            if (!mailTransporter) {
                console.error("Mail transporter not available for email action.");
                return res.status(500).json({ success: false, message: "Server error: Email service not available." });
            }
            const recipientEmail = settings.schoolContactEmail || process.env.SCHOOL_CONTACT_EMAIL_TO;
            if (!recipientEmail) {
                console.error("School contact email (to send TO) is not configured.");
                return res.status(500).json({ success: false, message: "Server error: Recipient email not set." });
            }
            const mailOptions = {
                from: `"${contactName} via School Website" <${process.env.EMAIL_FROM_ADDRESS || 'noreply@example.com'}>`,
                replyTo: contactEmail,
                to: recipientEmail,
                subject: `New Contact Form: ${contactSubject}`,
                text: `You have a new submission:\n\nName: ${contactName}\nEmail: ${contactEmail}\n\nMessage:\n${contactMessage}`,
                html: `<p>You have a new submission:</p><ul><li><strong>Name:</strong> ${contactName}</li><li><strong>Email:</strong> ${contactEmail}</li></ul><p><strong>Message:</strong></p><p>${contactMessage.replace(/\n/g, '<br>')}</p>`,
            };
            try {
                await mailTransporter.sendMail(mailOptions);
                console.log('Contact form email sent successfully to:', recipientEmail);
                return res.json({ success: true, action: 'email', message: 'Your message has been sent successfully!' });
            } catch (emailError) {
                console.error('Error sending contact email:', emailError);
                return res.status(500).json({ success: false, action: 'email', message: 'Failed to send message. Please try again later.' });
            }
        }
        console.error(`Unknown contactFormAction: ${contactFormAction}`);
        return res.status(500).json({ success: false, message: "Server configuration error: Invalid contact form action." });
    });

} // End of setupApplication async function

// --- Database Table Initialization Function (needs to be defined before being called) ---
async function initializeDatabase() {
    if (!db) { // Check if db object is initialized
        console.error("Database client (db) not initialized. Skipping table initialization.");
        return;
    }
    try {
        await db.query(`CREATE TABLE IF NOT EXISTS settings (id SERIAL PRIMARY KEY, setting_name TEXT UNIQUE NOT NULL, setting_value TEXT)`);
        await db.query(`CREATE TABLE IF NOT EXISTS carousel_images (id SERIAL PRIMARY KEY, image_url TEXT NOT NULL, link_url TEXT, alt_text TEXT, file_name TEXT, display_order INTEGER)`);
        await db.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL)`);

        const defaultAdminUsername = process.env.ADMIN_USERNAME || 'admin';
        const defaultAdminPasswordPlain = process.env.ADMIN_PASSWORD_PLAIN || 'password123';
        
        const result = await db.query("SELECT * FROM users WHERE username = $1", [defaultAdminUsername]);

        if (result.rows.length === 0) {
            const hashedPassword = await bcrypt.hash(defaultAdminPasswordPlain, saltRounds);
            await db.query("INSERT INTO users (username, password) VALUES ($1, $2)", [defaultAdminUsername, hashedPassword]);
            console.log(`Default admin user ('${defaultAdminUsername}') created in Postgres DB.`);
        } else {
            console.log(`Admin user ('${defaultAdminUsername}') already exists in Postgres DB.`);
        }
    } catch (err) {
        console.error("Error initializing Postgres database tables:", err.message, err.stack);
    }
}


// Call the async setup function and start the server if local
setupApplication()
    .then(() => {
        // --- Server Start (for local development only) ---
        // Vercel handles starting the server from the exported 'app' module
        if (!process.env.VERCEL && process.env.NODE_ENV !== 'test') { // Vercel sets VERCEL=1; Avoid listening during tests
            const SERVER_PORT = process.env.PORT || 3000;
            app.listen(SERVER_PORT, () => {
                console.log(`Server is running locally on port ${SERVER_PORT}`);
                if (!process.env.SESSION_SECRET) {
                    console.warn("WARNING: SESSION_SECRET is not set. Using a fallback secret. THIS IS INSECURE FOR PRODUCTION.");
                }
                if (!process.env.KV_URL) {
                    console.error("CRITICAL WARNING: KV_URL is not set. Redis session store will not work if not connected.");
                }
                if (!process.env.POSTGRES_URL) {
                    console.error("CRITICAL WARNING: POSTGRES_URL is not set. Database operations will fail if not connected.");
                }
            });
        } else if (process.env.VERCEL) {
            console.log("Application setup complete. Vercel will handle server listening.");
        }
    })
    .catch(error => {
        console.error("FATAL: Failed to setup and start application:", error);
        process.exit(1); // Exit if critical setup fails
    });

// Export the app for Vercel
module.exports = app;