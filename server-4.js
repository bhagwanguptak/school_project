// server.js

// --- Core Dependencies ---
const dotenv = require('dotenv');
const path = require('path');
const express = require('express');
//const bodyParser = require('body-parser');
// server.js, line 18
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');

// --- New Database & Session Dependencies ---
const { Pool } = require('pg'); // For Vercel Postgres
const { createClient: createRedisClient } = require('redis'); // For Vercel KV
// server.js, line 30
const RedisStore = require("connect-redis").default;// Session store adapter

// --- File Upload & Blob Storage Dependencies ---
const multerLib = require('multer');
const { put, del, head } = require('@vercel/blob');

// --- Initializations ---
const app = express();
const saltRounds = 10;
const multer = multerLib({ storage: multerLib.memoryStorage() });
let mailTransporter;

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

// --- Vercel Postgres Database Setup ---
const db = new Pool({
  connectionString: process.env.POSTGRES_URL, // Provided by Vercel
  ssl: {
    rejectUnauthorized: false // Required for Vercel Postgres connections
  }
});
db.on('connect', () => console.log('Connected to Vercel Postgres database.'));
db.on('error', (err) => console.error('Postgres Pool Error:', err));

// --- Vercel KV (Redis) Session Store Setup ---
const redisClient = createRedisClient({
    url: process.env.KV_URL // Provided by Vercel
});
redisClient.on('error', err => console.error('Redis Client Error:', err));
redisClient.connect().catch(console.error);

const redisStore = new RedisStore({ client: redisClient });

// --- Nodemailer Setup ---
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  mailTransporter.verify((error) => {
    if (error) console.warn("Nodemailer: Error configuring mail transporter. Email sending will fail.", error.message);
    else console.log("Nodemailer: Server is ready to take our messages.");
  });
} else {
  console.warn("Nodemailer: SMTP environment variables not fully set. Email sending will be disabled.");
}

// --- Middlewares ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// --- Session Configuration (using Vercel KV) ---
app.use(session({
  store: redisStore,
  secret: process.env.SESSION_SECRET || 'fallback_super_secret_key_please_change_in_env_vars_for_prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // True in production (HTTPS)
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// --- Database Table Initialization ---
async function initializeDatabase() {
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
        console.error("Error initializing Postgres database tables:", err.message);
        // If this fails, the app might not work, so we log a severe error.
    }
}
initializeDatabase();

// --- Authentication Middleware ---
function checkAuth(req, res, next) {
  console.log(`CheckAuth for ${req.originalUrl}. Session ID: ${req.sessionID}, Authenticated: ${req.session ? req.session.authenticated : 'No session'}`);
  if (req.session && req.session.authenticated) {
    return next();
  }
  console.log('Auth check failed for path:', req.originalUrl, '- Responding with 401 for API or redirecting.');
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
                    console.log(`User '${user.username}' logged in successfully. Session authenticated: ${req.session.authenticated}, Session ID: ${req.sessionID}`);
                    req.session.save((saveErr) => {
                        if (saveErr) {
                            console.error("Error saving session after login:", saveErr);
                            return res.status(500).redirect('/login.html?error=Session+save+error');
                        }
                        res.redirect('/admin.html');
                    });
                });
            } else {
                console.log(`Login failed for username '${username}' (password mismatch).`);
                res.redirect('/login.html?error=Invalid+credentials');
            }
        } else {
            console.log(`Login failed for username '${username}' (user not found).`);
            res.redirect('/login.html?error=Invalid+credentials');
        }
    } catch (err) {
        console.error("Login DB error:", err);
        res.status(500).redirect('/login.html?error=Server+error');
    }
});

app.post('/api/logout', (req, res) => {
    if (req.session) {
        req.session.destroy(err => {
            if (err) {
                console.error("Error destroying session during logout:", err);
                return res.status(500).json({ message: "Logout failed." });
            }
            res.clearCookie('connect.sid');
            console.log('User logged out successfully.');
            return res.status(200).json({ message: 'Logout successful' });
        });
    } else {
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
                    value = (row.setting_name === 'facilityCards' ? [] : {});
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
    if (!settings || typeof settings !== 'object') {
        return res.status(400).json({ error: "Missing or invalid 'settings' object." });
    }

    const client = await db.connect(); // Use a transaction for multiple writes
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
        console.error("Error saving settings:", err.message);
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

// --- Specific Image Upload API Endpoints (USING VERCEL BLOB) ---
// These routes do not need changes as they don't interact with the SQL database.
const createUploadHandler = (entityName, formDataKey) => async (req, res) => {
    if (!req.file) return res.status(400).json({ message: `No ${entityName} file provided.` });
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

app.post('/api/upload-logo', checkAuth, multer.single('logo'), createUploadHandler('Logo', 'logo'));
app.post('/api/upload-about-image', checkAuth, multer.single('aboutImage'), createUploadHandler('About image', 'aboutImage'));
app.post('/api/upload-academics-image', checkAuth, multer.single('academicsImage'), createUploadHandler('Academics image', 'academicsImage'));


// --- Carousel API Endpoints (USING VERCEL BLOB & POSTGRES) ---
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
    
    const { linkURL, altText } = req.body;
    const originalFileName = req.file.originalname;

    try {
        // 1. Upload to Vercel Blob
        const blobFilename = generateBlobFilename(req.file.originalname);
        const blob = await put(blobFilename, req.file.buffer, { access: 'public', contentType: req.file.mimetype });
        const imageUrl = blob.url;
        console.log(`Carousel image uploaded to Vercel Blob: ${imageUrl}`);

        // 2. Save metadata to Postgres
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

    const client = await db.connect(); // Use transaction for multi-step operation
    try {
        await client.query('BEGIN');

        // 1. Find the image URL in the database
        const findResult = await client.query('SELECT image_url FROM carousel_images WHERE id = $1', [imageId]);
        if (findResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Image not found in database.' });
        }
        const imageUrlToDelete = findResult.rows[0].image_url;

        // 2. Delete the record from the database
        const deleteResult = await client.query('DELETE FROM carousel_images WHERE id = $1', [imageId]);
        if (deleteResult.rowCount === 0) {
           throw new Error('Image found but could not be deleted from database.');
        }

        // 3. Attempt to delete from Vercel Blob
        if (imageUrlToDelete && imageUrlToDelete.startsWith('http')) {
            try {
                await head(imageUrlToDelete); // Check if blob exists
                await del(imageUrlToDelete);
                console.log(`Successfully deleted from Vercel Blob: ${imageUrlToDelete}`);
            } catch (blobError) {
                if (blobError.status === 404) {
                    console.warn(`Blob not found on Vercel Blob (already deleted?): ${imageUrlToDelete}`);
                } else {
                    throw blobError; // A real blob error occurred, re-throw to rollback DB
                }
            }
        }
        
        await client.query('COMMIT');
        console.log(`Carousel image ID ${imageId} DB record and blob deleted.`);
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


// --- Server Start ---
const SERVER_PORT = process.env.PORT || 3000;
app.listen(SERVER_PORT, () => {
    console.log(`Server is running on port ${SERVER_PORT}`);
    if (process.env.NODE_ENV !== 'production') {
        console.log(`Access locally: http://localhost:${SERVER_PORT}`);
    }
});

// No need for a graceful shutdown process for the DB pool on Vercel,
// as the serverless function environment is managed automatically.