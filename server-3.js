// server.js
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
// Multer will be used for parsing multipart forms, using memory storage for blob uploads
const multerLib = require('multer'); // Require the library
const multer = multerLib({ storage: multerLib.memoryStorage() }); // Instantiate it
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');

// Import Vercel Blob SDK
const { put, del, head } = require('@vercel/blob');

const saltRounds = 10;
const app = express();
let mailTransporter;

// --- Environment Variable Loading (primarily for local development) ---
const envConfig = dotenv.config({ path: path.resolve(__dirname, 'variables.env') });
if (envConfig.error) {
  if (envConfig.error.code === 'ENOENT' && process.env.NODE_ENV === 'production') {
    console.log('variables.env not found (expected in production, using Vercel ENV VARS).');
  } else if (envConfig.error.code === 'ENOENT') {
    console.warn('Warning: variables.env file not found for local dev. Using system ENV VARS or code defaults.');
  } else {
    console.warn('Warning: Could not load variables.env file. Error:', envConfig.error);
  }
} else if (Object.keys(envConfig.parsed || {}).length === 0 && process.env.NODE_ENV !== 'production') {
  console.warn('Warning: variables.env file was found but is empty or contains no valid variables (local dev).');
} else if (process.env.NODE_ENV !== 'production'){
  console.log('Successfully loaded variables from variables.env for local development.');
}
console.log(`Current NODE_ENV: ${process.env.NODE_ENV}`);


// --- Nodemailer Setup ---
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
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
app.use(cors()); // Allow all origins
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // Serves HTML, CSS, client-side JS

// Serve COMMITTED default/placeholder images from public/uploads
// These are files you add to Git in the public/uploads folder.
const COMMITTED_UPLOADS_SERVE_PATH = path.join(__dirname, 'public', 'uploads');
app.use('/uploads', express.static(COMMITTED_UPLOADS_SERVE_PATH));
console.log(`Serving committed static uploads from: ${COMMITTED_UPLOADS_SERVE_PATH}`);

// --- Session Configuration (uses /tmp on Vercel, which is ephemeral) ---
app.use(session({
  store: new SQLiteStore({
    db: 'sessions.db', // This file will be created in /tmp
    dir: '/tmp',       // Vercel allows writing to /tmp
    table: 'sessions'
  }),
  secret: process.env.SESSION_SECRET || 'fallback_super_secret_key_please_change_in_env_vars_for_prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // True in production (HTTPS)
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// --- Application Database Setup (SQLite in /tmp, which is ephemeral) ---
const dbPath = path.join('/tmp', 'school.db'); // This file will be created in /tmp
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("Fatal error connecting to SQLite in /tmp:", err.message);
  } else {
    console.log('Connected to the school SQLite database in /tmp.');
  }
});

// --- Database Table Creation ---
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY AUTOINCREMENT, setting_name TEXT UNIQUE NOT NULL, setting_value TEXT)`, (err) => { if (err) console.error("Error creating settings table:", err.message); });
  db.run(`CREATE TABLE IF NOT EXISTS carousel_images (id INTEGER PRIMARY KEY AUTOINCREMENT, image_url TEXT NOT NULL, link_url TEXT, alt_text TEXT, file_name TEXT, display_order INTEGER)`, (err) => { if (err) console.error("Error creating carousel_images table:", err.message); });
  db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL)`, (err) => {
    if (err) return console.error("Error creating users table:", err.message);
    const defaultAdminUsername = process.env.ADMIN_USERNAME || 'admin';
    const defaultAdminPasswordPlain = process.env.ADMIN_PASSWORD_PLAIN || 'password123';
    db.get("SELECT * FROM users WHERE username = ?", [defaultAdminUsername], async (e, row) => {
      if (e) return console.error("Error checking admin user:", e.message);
      if (!row) {
        try {
          const hashedPassword = await bcrypt.hash(defaultAdminPasswordPlain, saltRounds);
          db.run("INSERT INTO users (username, password) VALUES (?, ?)", [defaultAdminUsername, hashedPassword], (iErr) => {
            if (iErr) console.error("Error inserting default admin:", iErr.message);
            else console.log(`Default admin user ('${defaultAdminUsername}') created in /tmp/school.db.`);
          });
        } catch (hErr) { console.error("Error hashing default admin password:", hErr); }
      } else {
        console.log(`Admin user ('${defaultAdminUsername}') already exists in /tmp/school.db.`);
      }
    });
  });
});

// --- Authentication Middleware ---
function checkAuth(req, res, next) {
  console.log(`CheckAuth for ${req.originalUrl}. Session ID: ${req.sessionID}, Authenticated: ${req.session ? req.session.authenticated : 'No session'}`);
  if (req.session && req.session.authenticated) {
    return next();
  }
  console.log('Auth check failed for path:', req.originalUrl, '- Responding with 401 for API or redirecting.');
  if (req.originalUrl.startsWith('/api/')) { // For API requests, send JSON error
    return res.status(401).json({ error: 'Unauthorized. Please log in.', redirectTo: '/login.html?unauthorized=true' });
  }
  res.redirect('/login.html?unauthorized=true'); // For page requests, redirect
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
  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err) { console.error("Login DB error:", err); return res.status(500).redirect('/login.html?error=Server+error'); }
    if (user) {
      try {
        const match = await bcrypt.compare(plainTextPassword, user.password);
        if (match) {
          req.session.regenerate((regenErr) => { // Regenerate session on login for security
            if (regenErr) { console.error("Session regeneration error:", regenErr); return res.status(500).redirect('/login.html?error=Session+error'); }
            req.session.authenticated = true;
            req.session.username = user.username;
            console.log(`User '${user.username}' logged in successfully. Session authenticated: ${req.session.authenticated}, Session ID: ${req.sessionID}`);
            req.session.save((saveErr) => { // Explicitly save session
              if (saveErr) { console.error("Error saving session after login:", saveErr); return res.status(500).redirect('/login.html?error=Session+save+error'); }
              console.log("Session saved successfully after login. Redirecting to /admin.html");
              res.redirect('/admin.html');
            });
          });
        } else { console.log(`Login failed for username '${username}' (password mismatch).`); res.redirect('/login.html?error=Invalid+credentials'); }
      } catch (compareError) { console.error("Error comparing passwords:", compareError); res.status(500).redirect('/login.html?error=Login+check+error'); }
    } else { console.log(`Login failed for username '${username}' (user not found).`); res.redirect('/login.html?error=Invalid+credentials'); }
  });
});

app.post('/api/logout', (req, res) => {
  if (req.session) {
    req.session.destroy(err => {
      if (err) { console.error("Error destroying session during logout:", err); return res.status(500).json({ message: "Logout failed." }); }
      res.clearCookie('connect.sid'); console.log('User logged out successfully.'); return res.status(200).json({ message: 'Logout successful' });
    });
  } else { console.log('Logout attempt with no active session.'); return res.status(200).json({ message: 'No active session to log out from.' }); }
});

// --- Settings API ---
app.get('/api/settings', (req, res) => {
  db.all('SELECT setting_name, setting_value FROM settings', [], (err, rows) => {
    if (err) { console.error("GET /api/settings DB error:", err.message); return res.status(500).json({ error: 'Failed to retrieve settings from database.' });}
    const settings = {};
    const jsonKeys = ['socialLinks', 'facilityCards', 'heroGradient', 'aboutGradient', 'admissionsGradient', 'academicsGradient', 'facilitiesGradient', 'contactGradient'];
    rows.forEach(row => {
      let value = row.setting_value;
      if (jsonKeys.includes(row.setting_name)) {
        try {
          if (value && typeof value === 'string' && value.trim() !== '') value = JSON.parse(value);
          else { // Provide sensible defaults for empty/null structured data
            if (row.setting_name === 'facilityCards') value = [];
            else if (row.setting_name.endsWith('Gradient') || row.setting_name === 'socialLinks') value = {};
            else value = null;
          }
        } catch (e) {
          console.warn(`Could not parse setting '${row.setting_name}' as JSON. Value: "${row.setting_value}". Error:`, e.message);
          // Fallback if JSON is malformed
          if (row.setting_name === 'facilityCards') value = [];
          else if (row.setting_name.endsWith('Gradient') || row.setting_name === 'socialLinks') value = {};
          else value = row.setting_value; // Keep original string
        }
      }
      settings[row.setting_name] = value;
    });
    res.json(settings);
  });
});

app.post('/api/settings', checkAuth, (req, res) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object') return res.status(400).json({ error: "Missing or invalid 'settings' object." });
  db.serialize(() => {
    db.run("BEGIN TRANSACTION;", (err) => { if (err) return res.status(500).json({ error: "Failed to start transaction: " + err.message }); });
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (setting_name, setting_value) VALUES (?, ?)');
    let operations = [];
    Object.entries(settings).forEach(([key, value]) => {
      let valueToStore = value;
      if (typeof value === 'object' && value !== null) {
        try { valueToStore = JSON.stringify(value); }
        catch (e) { console.error(`Could not stringify setting '${key}'. Storing as plain string.`); valueToStore = String(value); }
      }
      if (typeof valueToStore !== 'string') {
        valueToStore = valueToStore === null || typeof valueToStore === 'undefined' ? '' : String(valueToStore);
      }
      operations.push(new Promise((resolve, reject) => { stmt.run(key, valueToStore, function(e) { if (e) reject(e); else resolve(); }); }));
    });
    Promise.all(operations)
      .then(() => {
        stmt.finalize((finalizeErr) => {
          if (finalizeErr) {
            console.error("Error finalizing settings statement:", finalizeErr.message);
            db.run("ROLLBACK;"); return res.status(500).json({ error: "Failed to finalize settings update: " + finalizeErr.message });
          }
          db.run("COMMIT;", (commitErr) => {
            if (commitErr) { console.error("Error committing settings transaction:", commitErr.message); return res.status(500).json({ error: "Failed to commit settings: " + commitErr.message }); }
            res.json({ message: 'Settings saved successfully' });
          });
        });
      })
      .catch(error => {
        console.error("Error during one or more setting saves:", error.message);
        stmt.finalize(); db.run("ROLLBACK;");
        res.status(500).json({ error: "Failed to save one or more settings." });
      });
  });
});


// --- Vercel Blob File Handling ---
const generateBlobFilename = (originalName) => {
  const timestamp = Date.now();
  const randomString = Math.random().toString(36).substring(2, 8);
  const ext = path.extname(originalName);
  const basename = path.basename(originalName, ext).substring(0, 50).replace(/[^a-zA-Z0-9_.-]/g, '_');
  // Example path prefix for organization within the blob store, adjust as needed
  return `school_assets/images/${basename}-${timestamp}-${randomString}${ext}`;
};

// --- Specific Image Upload API Endpoints (USING VERCEL BLOB) ---
app.post('/api/upload-logo', checkAuth, multer.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No logo file provided.' });
  try {
    const blobFilename = generateBlobFilename(req.file.originalname);
    const blob = await put(blobFilename, req.file.buffer, { access: 'public', contentType: req.file.mimetype });
    console.log(`Logo uploaded to Vercel Blob: ${blob.url}`);
    res.json({ message: 'Logo uploaded successfully to Vercel Blob.', url: blob.url });
  } catch (error) { console.error("Error uploading logo to Vercel Blob:", error); res.status(500).json({ message: 'Failed to upload logo.', error: error.message }); }
});
app.post('/api/upload-about-image', checkAuth, multer.single('aboutImage'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No "About Us" image file provided.' });
  try {
    const blobFilename = generateBlobFilename(req.file.originalname);
    const blob = await put(blobFilename, req.file.buffer, { access: 'public', contentType: req.file.mimetype });
    console.log(`About image uploaded to Vercel Blob: ${blob.url}`);
    res.json({ message: 'About Us image uploaded successfully to Vercel Blob.', url: blob.url });
  } catch (error) { console.error("Error uploading about image to Vercel Blob:", error); res.status(500).json({ message: 'Failed to upload About Us image.', error: error.message }); }
});
app.post('/api/upload-academics-image', checkAuth, multer.single('academicsImage'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No "Academics" image file provided.' });
  try {
    const blobFilename = generateBlobFilename(req.file.originalname);
    const blob = await put(blobFilename, req.file.buffer, { access: 'public', contentType: req.file.mimetype });
    console.log(`Academics image uploaded to Vercel Blob: ${blob.url}`);
    res.json({ message: 'Academics image uploaded successfully to Vercel Blob.', url: blob.url });
  } catch (error) { console.error("Error uploading academics image to Vercel Blob:", error); res.status(500).json({ message: 'Failed to upload Academics image.', error: error.message }); }
});

// --- Carousel API Endpoints (USING VERCEL BLOB) ---
app.get('/api/carousel', (req, res) => {
  db.all('SELECT id, image_url, link_url, alt_text, file_name, display_order FROM carousel_images ORDER BY display_order ASC, id ASC', [], (err, rows) => {
    if (err) { console.error("GET /api/carousel error:", err.message); return res.status(500).json({ error: "Failed to retrieve carousel images." }); }
    res.json(rows);
  });
});

app.post('/api/carousel', checkAuth, multer.single('carouselImage'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No carousel image file uploaded.' });
  const linkURL = req.body.linkURL || null;
  const altText = req.body.altText || `Carousel Image`;
  const originalFileName = req.file.originalname; // For DB reference
  try {
    const blobFilename = generateBlobFilename(req.file.originalname);
    const blob = await put(blobFilename, req.file.buffer, { access: 'public', contentType: req.file.mimetype });
    const imageUrl = blob.url; // This is the Vercel Blob public URL
    console.log(`Carousel image uploaded to Vercel Blob: ${imageUrl}`);

    const sql = `INSERT INTO carousel_images (image_url, link_url, alt_text, file_name, display_order) VALUES (?, ?, ?, ?, (SELECT IFNULL(MAX(display_order), 0) + 1 FROM carousel_images))`;
    db.run(sql, [imageUrl, linkURL, altText, originalFileName], function(err) {
      if (err) {
        console.error("Carousel image insert DB error:", err.message);
        console.warn(`Blob ${imageUrl} was uploaded but DB insert failed. Manual cleanup of blob may be needed.`);
        return res.status(500).json({ error: "Failed to save carousel image to database: " + err.message });
      }
      res.status(201).json({ message: 'Carousel image added successfully.', image: { id: this.lastID, image_url: imageUrl, link_url: linkURL, alt_text: altText, file_name: originalFileName } });
    });
  } catch (error) { console.error("Error uploading carousel image or saving to DB:", error); res.status(500).json({ error: "Failed to add carousel image.", details: error.message }); }
});

app.delete('/api/carousel/:id', checkAuth, async (req, res) => {
  const imageId = parseInt(req.params.id, 10);
  if (isNaN(imageId)) return res.status(400).json({ error: 'Invalid image ID.' });
  db.get('SELECT image_url FROM carousel_images WHERE id = ?', [imageId], async (err, row) => {
    if (err) { console.error("Error finding image for deletion (DB):", err.message); return res.status(500).json({ error: 'DB error while finding image.' }); }
    if (!row) return res.status(404).json({ error: 'Image not found in database.' });
    const imageUrlToDelete = row.image_url;
    try {
      // Only attempt to delete from Blob if it's a full URL (likely a Blob URL)
      if (imageUrlToDelete && imageUrlToDelete.startsWith('http')) {
        try {
          await head(imageUrlToDelete); // Check if blob exists
          await del(imageUrlToDelete);
          console.log(`Successfully deleted from Vercel Blob: ${imageUrlToDelete}`);
        } catch (blobError) {
          if (blobError.status === 404) console.warn(`Blob not found on Vercel Blob (already deleted or invalid URL?): ${imageUrlToDelete}`);
          else throw blobError; // Re-throw other blob errors to be caught by the outer try-catch
        }
      } else {
        console.warn(`Skipping Vercel Blob deletion for non-HTTP URL (possibly local/committed path): ${imageUrlToDelete}`);
      }

      db.run('DELETE FROM carousel_images WHERE id = ?', [imageId], function(dbErr) {
        if (dbErr) {
          console.error("Error deleting image from database (DB):", dbErr.message);
          console.warn(`Blob ${imageUrlToDelete} potentially processed for deletion but DB record removal failed for ID ${imageId}.`);
          return res.status(500).json({ error: 'Database error while deleting image record.' });
        }
        if (this.changes === 0) { console.warn(`DB: Image ID ${imageId} not found for deletion, or already deleted.`); return res.status(404).json({ error: 'Image not found in database for deletion.' }); }
        console.log(`Carousel image ID ${imageId} DB record deleted.`);
        res.json({ message: 'Carousel image deletion processed.' });
      });
    } catch (blobDeleteError) {
      console.error("Error during Vercel Blob deletion processing:", blobDeleteError);
      res.status(500).json({ error: 'Failed to process image deletion from Vercel Blob.', details: blobDeleteError.message });
    }
  });
});

// --- CONTACT FORM SUBMISSION API ---
app.post('/api/submit-contact', async (req, res) => {
  const { contactName, contactEmail, contactSubject, contactMessage } = req.body;
  if (!contactName || !contactEmail || !contactSubject || !contactMessage) { return res.status(400).json({ success: false, message: "All fields are required." }); }
  let contactFormActionSetting = process.env.CONTACT_FORM_ACTION_DEFAULT || 'whatsapp';
  let schoolContactEmailSetting = process.env.SCHOOL_CONTACT_EMAIL_TO;
  let dbSchoolWhatsappNumber = null;
  try {
    const settingsRows = await new Promise((resolve, reject) => {
      db.all('SELECT setting_name, setting_value FROM settings WHERE setting_name IN (?, ?, ?)',
        ['contactFormAction', 'schoolContactEmail', 'adminSchoolWhatsappNumber'], (err, rows) => { if (err) return reject(err); resolve(rows); });
    });
    settingsRows.forEach(row => {
      if (row.setting_name === 'contactFormAction' && row.setting_value) contactFormActionSetting = row.setting_value;
      if (row.setting_name === 'schoolContactEmail' && row.setting_value) schoolContactEmailSetting = row.setting_value;
      if (row.setting_name === 'adminSchoolWhatsappNumber' && row.setting_value && row.setting_value.trim() !== '') dbSchoolWhatsappNumber = row.setting_value.trim();
    });
  } catch (dbError) { console.error("Error fetching contact settings from DB:", dbError.message); }

  if (contactFormActionSetting === 'whatsapp') {
    const schoolWhatsAppNumberToUse = dbSchoolWhatsappNumber || process.env.SCHOOL_WHATSAPP_NUMBER;
    if (!schoolWhatsAppNumberToUse || schoolWhatsAppNumberToUse.trim() === '') { console.error("WhatsApp number not configured for contact form."); return res.status(500).json({ success: false, message: "Server error: WhatsApp number not set." }); }
    const whatsappMessageBody = `New Contact Form Submission:\nName: ${contactName}\nEmail: ${contactEmail}\nSubject: ${contactSubject}\nMessage:\n${contactMessage}`;
    const whatsappUrl = `https://wa.me/${schoolWhatsAppNumberToUse.replace(/\D/g, '')}?text=${encodeURIComponent(whatsappMessageBody)}`;
    return res.json({ success: true, action: 'whatsapp', whatsappUrl: whatsappUrl, message: "Please click 'Send' in WhatsApp." });
  } else if (contactFormActionSetting === 'email') {
    if (!mailTransporter) { console.error("Mail transporter not available for email action."); return res.status(500).json({ success: false, message: "Server error: Email service not available." }); }
    if (!schoolContactEmailSetting || schoolContactEmailSetting.trim() === '') { console.error("School contact email (to send TO) is not configured for email action."); return res.status(500).json({ success: false, message: "Server error: Recipient email not set." }); }
    const mailOptions = {
      from: `"${contactName} via School Website" <${process.env.EMAIL_FROM_ADDRESS || 'noreply@example.com'}>`, replyTo: contactEmail,
      to: schoolContactEmailSetting, subject: `New Contact Form: ${contactSubject}`,
      text: `You have a new contact form submission:\n\nName: ${contactName}\nEmail: ${contactEmail}\nSubject: ${contactSubject}\n\nMessage:\n${contactMessage}`,
      html: `<p>You have a new contact form submission:</p><ul><li><strong>Name:</strong> ${contactName}</li><li><strong>Email:</strong> ${contactEmail}</li><li><strong>Subject:</strong> ${contactSubject}</li></ul><p><strong>Message:</strong></p><p>${contactMessage.replace(/\n/g, '<br>')}</p>`,
    };
    try {
      await mailTransporter.sendMail(mailOptions);
      console.log('Email sent successfully to:', schoolContactEmailSetting);
      return res.json({ success: true, action: 'email', message: 'Your message has been sent successfully!' });
    } catch (emailError) { console.error('Error sending email:', emailError); return res.status(500).json({ success: false, action: 'email', message: 'Failed to send message. Please try again later.' });}
  } else {
    console.error(`Unknown contactFormAction: ${contactFormActionSetting}`);
    return res.status(500).json({ success: false, message: "Server configuration error: Invalid contact form action." });
  }
});

// --- Server Start ---
const SERVER_PORT = process.env.PORT || 3000; // Vercel provides the PORT env variable
app.listen(SERVER_PORT, () => {
  console.log(`Server is running on port ${SERVER_PORT}`);
  if (process.env.NODE_ENV !== 'production') {
    console.log(`Access locally: http://localhost:${SERVER_PORT}`);
    console.log(`Admin default credentials (local dev): ${process.env.ADMIN_USERNAME || 'admin'} / ${process.env.ADMIN_PASSWORD_PLAIN || 'password123'}`);
    console.log(`Session Secret is: ${process.env.SESSION_SECRET ? 'CONFIGURED via ENV' : 'USING FALLBACK (INSECURE)'}`);
  }
});

// Graceful shutdown (useful for local dev, Vercel handles instance lifecycle)
process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing SQLite database.');
  db.close((err) => {
    if (err) console.error("Error closing SQLite DB from /tmp:", err.message);
    else console.log('SQLite database connection from /tmp closed.');
    process.exit(0);
  });
});