// server.js
// server.js - at the very top
const dotenv = require('dotenv');
const path = require('path'); // You'll likely need 'path' for joining directory paths
const fs = require('fs'); // For file system operations

// Load variables from 'variables.env' in the current directory (for local dev)
// On Vercel, this will fail gracefully if variables.env is not present (which it shouldn't be)
// and the app will rely on Vercel's environment variables.
const envConfig = dotenv.config({ path: path.resolve(__dirname, 'variables.env') });

if (envConfig.error) {
  if (envConfig.error.code === 'ENOENT') {
    console.warn('Warning: variables.env file not found. Using Vercel environment variables or code defaults.');
  } else {
    console.warn('Warning: Could not load variables.env file. Error:', envConfig.error);
  }
} else if (Object.keys(envConfig.parsed || {}).length === 0 && process.env.NODE_ENV !== 'production') {
  // Only warn if not in production and file is empty
  console.warn('Warning: variables.env file was found but is empty or contains no valid variables.');
} else if (process.env.NODE_ENV !== 'production'){
  console.log('Successfully loaded variables from variables.env for local development.');
}


const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session); // For persistent sessions
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');

const saltRounds = 10; // Cost factor for bcrypt hashing

const app = express();
let mailTransporter;

if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  mailTransporter.verify(function(error, success) {
    if (error) {
      console.warn("Nodemailer: Error configuring mail transporter. Email sending will fail.", error.message);
    } else {
      console.log("Nodemailer: Server is ready to take our messages");
    }
  });
} else {
  console.warn("Nodemailer: SMTP environment variables not fully set. Email sending will be disabled.");
}

// --- Middlewares ---
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files from 'public' directory (HTML, CSS, client-side JS)
// These files are part of your deployment bundle.
app.use(express.static(path.join(__dirname, 'public')));

// Serve COMMITTED uploaded files statically from 'public/uploads'
// These files are part of your deployment bundle if you committed them.
const COMMITTED_UPLOADS_SERVE_PATH = path.join(__dirname, 'public', 'uploads');
app.use('/uploads', express.static(COMMITTED_UPLOADS_SERVE_PATH));
console.log(`Serving committed uploads from: ${COMMITTED_UPLOADS_SERVE_PATH}`);


// Session Configuration - Modified for Vercel /tmp
app.use(session({
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: '/tmp', // Use /tmp for Vercel (ephemeral storage)
    table: 'sessions'
  }),
  secret: process.env.SESSION_SECRET || 'fallback_super_secret_key_please_change_in_env',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Initialize SQLite database - Modified for Vercel /tmp
const dbPath = path.join('/tmp', 'school.db'); // Use /tmp for Vercel (ephemeral storage)
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("Fatal error connecting to SQLite in /tmp:", err.message);
    // In a serverless environment, process.exit might not be ideal.
    // The function might fail, and Vercel will log it.
    // Consider how your app should behave if the DB connection fails.
  } else {
    console.log('Connected to the school SQLite database in /tmp.');
  }
});

// Create tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    setting_name TEXT UNIQUE NOT NULL,
    setting_value TEXT
  )`, (err) => {
    if (err) console.error("Error creating settings table:", err.message);
  });

  db.run(`CREATE TABLE IF NOT EXISTS carousel_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_url TEXT NOT NULL,
    link_url TEXT,
    alt_text TEXT,
    file_name TEXT,
    display_order INTEGER
  )`, (err) => {
    if (err) console.error("Error creating carousel_images table:", err.message);
  });

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  )`, (err) => {
    if (err) return console.error("Error creating users table:", err.message);

    const defaultAdminUsername = process.env.ADMIN_USERNAME || 'admin';
    const defaultAdminPasswordPlain = process.env.ADMIN_PASSWORD_PLAIN || 'password123';

    db.get("SELECT * FROM users WHERE username = ?", [defaultAdminUsername], async (err, row) => {
      if (err) return console.error("Error checking admin user:", err.message);
      if (!row) {
        try {
          const hashedPassword = await bcrypt.hash(defaultAdminPasswordPlain, saltRounds);
          db.run("INSERT INTO users (username, password) VALUES (?, ?)",
            [defaultAdminUsername, hashedPassword], (insertErr) => {
            if (insertErr) return console.error("Error inserting default admin:", insertErr.message);
            console.log(`Default admin user ('${defaultAdminUsername}') created in /tmp/school.db.`);
          });
        } catch (hashError) {
          console.error("Error hashing default admin password:", hashError);
        }
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
  console.log('Auth check failed for path:', req.originalUrl, '- Responding with 401.');
  // For API routes, respond with JSON instead of redirecting HTML page
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

  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err) {
      console.error("Login DB error:", err);
      return res.status(500).redirect('/login.html?error=' + encodeURIComponent('Server error during login.'));
    }

    if (user) {
      try {
        const match = await bcrypt.compare(plainTextPassword, user.password);
        if (match) {
          req.session.regenerate(function(regenErr) {
            if (regenErr) {
              console.error("Error regenerating session:", regenErr);
              return res.status(500).redirect('/login.html?error=' + encodeURIComponent('Server error during session regeneration.'));
            }
            req.session.authenticated = true;
            req.session.username = user.username;
            console.log(`User '${user.username}' logged in. Session authenticated: ${req.session.authenticated}`);
            console.log(`Session ID after login & regeneration: ${req.sessionID}`);
            req.session.save(saveErr => {
              if (saveErr) {
                console.error("Error saving session after login:", saveErr);
                return res.status(500).redirect('/login.html?error=' + encodeURIComponent('Server error during session save.'));
              }
              console.log("Session saved successfully after login. Redirecting to /admin.html");
              res.redirect('/admin.html');
            });
          });
        } else {
          console.log(`Login failed for username '${username}' (password mismatch).`);
          res.redirect('/login.html?error=' + encodeURIComponent('Invalid username or password.'));
        }
      } catch (compareError) {
        console.error("Error comparing passwords:", compareError);
        res.status(500).redirect('/login.html?error=' + encodeURIComponent('Server error during login check.'));
      }
    } else {
      console.log(`Login failed for username '${username}' (user not found).`);
      res.redirect('/login.html?error=' + encodeURIComponent('Invalid username or password.'));
    }
  });
});

app.post('/api/logout', (req, res) => {
  if (req.session) {
    req.session.destroy(err => {
      if (err) {
        console.error("Error destroying session during logout:", err);
        return res.status(500).json({ message: "Logout failed. Could not clear session." });
      }
      res.clearCookie('connect.sid');
      console.log('User logged out successfully.');
      return res.status(200).json({ message: 'Logout successful' });
    });
  } else {
    console.log('Logout attempt with no active session.');
    return res.status(200).json({ message: 'No active session to log out from.' });
  }
});

// --- Settings API ---
app.get('/api/settings', (req, res) => {
  db.all('SELECT setting_name, setting_value FROM settings', [], (err, rows) => {
    if (err) {
      console.error("GET /api/settings DB error:", err.message);
      return res.status(500).json({ error: 'Failed to retrieve settings from database.' });
    }
    const settings = {};
    const jsonKeys = ['socialLinks', 'facilityCards', 'heroGradient', 'aboutGradient', 'admissionsGradient', 'academicsGradient', 'facilitiesGradient', 'contactGradient'];
    rows.forEach(row => {
      let value = row.setting_value;
      if (jsonKeys.includes(row.setting_name)) {
        try {
          if (value && typeof value === 'string' && value.trim() !== '') value = JSON.parse(value);
          else {
            if (row.setting_name === 'facilityCards') value = [];
            else if (row.setting_name.endsWith('Gradient') || row.setting_name === 'socialLinks') value = {};
            else value = null;
          }
        } catch (e) {
          console.warn(`Could not parse setting '${row.setting_name}' as JSON. Value: "${row.setting_value}". Error:`, e.message);
          if (row.setting_name === 'facilityCards') value = [];
          else if (row.setting_name.endsWith('Gradient') || row.setting_name === 'socialLinks') value = {};
          else value = row.setting_value;
        }
      }
      settings[row.setting_name] = value;
    });
    res.json(settings);
  });
});

app.post('/api/settings', checkAuth, (req, res) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: "Missing or invalid 'settings' object in request body." });
  }
  db.serialize(() => {
    db.run("BEGIN TRANSACTION;", (err) => { if (err) return res.status(500).json({ error: "Failed to start transaction: " + err.message }); });
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (setting_name, setting_value) VALUES (?, ?)');
    let operations = [];
    Object.entries(settings).forEach(([key, value]) => {
      let valueToStore = value;
      if (typeof value === 'object' && value !== null) {
        try { valueToStore = JSON.stringify(value); }
        catch (e) { console.error(`Could not stringify setting '${key}'. Storing as string.`); valueToStore = String(value); }
      }
      if (typeof valueToStore !== 'string') {
        valueToStore = valueToStore === null || typeof valueToStore === 'undefined' ? '' : String(valueToStore);
      }
      operations.push(new Promise((resolve, reject) => {
        stmt.run(key, valueToStore, function(err) { if (err) reject(err); else resolve(); });
      }));
    });
    Promise.all(operations)
      .then(() => {
        stmt.finalize((finalizeErr) => {
          if (finalizeErr) {
            console.error("Error finalizing settings statement:", finalizeErr.message);
            db.run("ROLLBACK;"); return res.status(500).json({ error: "Failed to finalize settings update: " + finalizeErr.message });
          }
          db.run("COMMIT;", (commitErr) => {
            if (commitErr) return res.status(500).json({ error: "Failed to commit settings: " + commitErr.message });
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

// --- Multer Configuration ---
// Path for RUNTIME UPLOADS by users (e.g., via Multer) - ephemeral on Vercel
const RUNTIME_UPLOADS_TEMP_PATH = path.join('/tmp', 'uploads_runtime'); // Changed name slightly to avoid conflict if /tmp/uploads is used elsewhere
if (!fs.existsSync(RUNTIME_UPLOADS_TEMP_PATH)) {
  try {
    fs.mkdirSync(RUNTIME_UPLOADS_TEMP_PATH, { recursive: true });
    console.log(`Runtime temporary uploads directory created: ${RUNTIME_UPLOADS_TEMP_PATH}`);
  } catch (mkdirErr) {
    console.warn(`Warning: Could not create runtime uploads directory in /tmp: ${RUNTIME_UPLOADS_TEMP_PATH}`, mkdirErr.message);
  }
}

const generateFilename = (originalName) => {
  const timestamp = Date.now();
  const randomString = Math.random().toString(36).substring(2, 8);
  const ext = path.extname(originalName);
  const basename = path.basename(originalName, ext).substring(0, 50);
  const sanitizedBasename = basename.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `${sanitizedBasename}-${timestamp}-${randomString}${ext}`;
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, RUNTIME_UPLOADS_TEMP_PATH); // Save new uploads to /tmp/uploads_runtime
  },
  filename: (req, file, cb) => {
    cb(null, generateFilename(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else { console.warn("Attempted non-image upload:", file.originalname, file.mimetype); cb(new Error('Only image files allowed.'), false); }
  },
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

const multerErrorHandler = (error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        console.error("Multer error:", error.code, error.field);
        return res.status(400).json({ message: `File upload error: ${error.message}` });
    } else if (error) {
        console.error("Non-Multer upload error:", error.message);
        return res.status(400).json({ message: error.message });
    }
    next();
};

// --- Specific Image Upload API Endpoints ---
// Note: URLs returned like `/uploads/...` will refer to the static path for committed files.
// If you want to serve files uploaded to /tmp, you'd need a separate route or use cloud storage.
// For now, these return a path that won't directly work for files just uploaded to /tmp via these endpoints
// unless you implement a way to serve from /tmp or (preferably) move to cloud storage.
// The client-side preview will work, but the persisted URL in settings might be misleading for /tmp files.
app.post('/api/upload-logo', checkAuth, upload.single('logo'), multerErrorHandler, (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No logo file.' });
  // For files in /tmp, the URL should ideally be different or handled differently.
  // This URL implies it's served from the static COMMITTED_UPLOADS_SERVE_PATH.
  res.json({ message: 'Logo uploaded successfully to temp storage.', url: `/uploads/${req.file.filename}`, tempPath: req.file.path });
});

app.post('/api/upload-about-image', checkAuth, upload.single('aboutImage'), multerErrorHandler, (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No "About Us" image.' });
  res.json({ message: 'About Us image uploaded to temp storage.', url: `/uploads/${req.file.filename}`, tempPath: req.file.path });
});

app.post('/api/upload-academics-image', checkAuth, upload.single('academicsImage'), multerErrorHandler, (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No "Academics" image.' });
  res.json({ message: 'Academics image uploaded to temp storage.', url: `/uploads/${req.file.filename}`, tempPath: req.file.path });
});

// --- Carousel API Endpoints ---
app.get('/api/carousel', (req, res) => {
  db.all('SELECT id, image_url, link_url, alt_text, file_name, display_order FROM carousel_images ORDER BY display_order ASC, id ASC', [], (err, rows) => {
    if (err) { console.error("GET /api/carousel error:", err.message); return res.status(500).json({ error: "Failed to retrieve." }); }
    res.json(rows);
  });
});

app.post('/api/carousel', checkAuth, upload.single('carouselImage'), multerErrorHandler, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No carousel image file uploaded.' });

  // The imageUrl saved to DB will be /uploads/..., implying it's served statically.
  // If this image was just uploaded to /tmp, this DB entry is problematic long-term without cloud storage.
  const imageUrl = `/uploads/${req.file.filename}`; // This path assumes it will be served from COMMITTED_UPLOADS_SERVE_PATH
  const linkURL = req.body.linkURL || null;
  const altText = req.body.altText || `Carousel Image`;
  const fileName = req.file.originalname; // Original name, not the one in /tmp

  const sql = `INSERT INTO carousel_images (image_url, link_url, alt_text, file_name, display_order)
               VALUES (?, ?, ?, ?, (SELECT IFNULL(MAX(display_order), 0) + 1 FROM carousel_images))`;
  db.run(sql, [imageUrl, linkURL, altText, fileName], function(err) {
    if (err) { console.error("Carousel insert DB error:", err.message); return res.status(500).json({ error: "Failed to save to DB." }); }
    res.status(201).json({ message: 'Carousel image added (URL points to static path).', image: { id: this.lastID, image_url: imageUrl, /*...other props...*/ } });
  });
});

app.delete('/api/carousel/:id', checkAuth, (req, res) => {
  const imageId = parseInt(req.params.id, 10);
  if (isNaN(imageId)) return res.status(400).json({ error: 'Invalid image ID.' });

  db.get('SELECT image_url FROM carousel_images WHERE id = ?', [imageId], (err, row) => {
    if (err) { console.error("Error finding image for deletion:", err.message); return res.status(500).json({ error: 'DB error find.' }); }
    if (!row) return res.status(404).json({ error: 'Image not found in DB.' });

    // This filePath assumes image_url points to a file relative to COMMITTED_UPLOADS_SERVE_PATH
    // Deleting from /tmp requires knowing the actual temp filename if different.
    // For now, this attempts to delete from the "committed" location, which won't apply to /tmp files.
    const filePath = path.join(COMMITTED_UPLOADS_SERVE_PATH, path.basename(row.image_url));

    fs.unlink(filePath, (unlinkErr) => {
      if (unlinkErr && unlinkErr.code !== 'ENOENT') {
          console.warn(`Filesystem: Image file ${filePath} could not be deleted (might be ok if it was a /tmp upload):`, unlinkErr.message);
      }
      db.run('DELETE FROM carousel_images WHERE id = ?', [imageId], function(dbErr) {
        if (dbErr) { console.error("Error deleting image from DB:", dbErr.message); return res.status(500).json({ error: 'DB error delete.' }); }
        if (this.changes === 0) return res.status(404).json({ error: 'Image not found for DB deletion.' });
        res.json({ message: 'Carousel image DB record deleted.' });
      });
    });
  });
});

// --- CONTACT FORM SUBMISSION API ---
app.post('/api/submit-contact', async (req, res) => {
  const { contactName, contactEmail, contactSubject, contactMessage } = req.body;
  if (!contactName || !contactEmail || !contactSubject || !contactMessage) {
    return res.status(400).json({ success: false, message: "All fields are required." });
  }
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
    if (!schoolWhatsAppNumberToUse || schoolWhatsAppNumberToUse.trim() === '') {
      console.error("WhatsApp number not configured for contact form.");
      return res.status(500).json({ success: false, message: "Server error: WhatsApp number not set." });
    }
    const whatsappMessageBody = `New Contact: ${contactName} (${contactEmail}) - Subject: ${contactSubject} - Message: ${contactMessage}`;
    const whatsappUrl = `https://wa.me/${schoolWhatsAppNumberToUse.replace(/\D/g, '')}?text=${encodeURIComponent(whatsappMessageBody)}`;
    return res.json({ success: true, action: 'whatsapp', whatsappUrl: whatsappUrl, message: "Redirecting to WhatsApp." });
  } else if (contactFormActionSetting === 'email') {
    if (!mailTransporter) { console.error("Mail transporter N/A."); return res.status(500).json({ success: false, message: "Server error: Email service N/A." }); }
    if (!schoolContactEmailSetting || schoolContactEmailSetting.trim() === '') { console.error("Recipient email N/A."); return res.status(500).json({ success: false, message: "Server error: Recipient email N/A." }); }
    const mailOptions = {
      from: `"${contactName}" <${process.env.EMAIL_FROM_ADDRESS || 'noreply@example.com'}>`, replyTo: contactEmail,
      to: schoolContactEmailSetting, subject: `Contact Form: ${contactSubject}`,
      text: `Name: ${contactName}\nEmail: ${contactEmail}\nSubject: ${contactSubject}\nMessage:\n${contactMessage}`,
      html: `<p>Name: ${contactName}</p><p>Email: ${contactEmail}</p><p>Subject: ${contactSubject}</p><p>Message:</p><p>${contactMessage.replace(/\n/g, '<br>')}</p>`,
    };
    try {
      await mailTransporter.sendMail(mailOptions);
      return res.json({ success: true, action: 'email', message: 'Message sent!' });
    } catch (emailError) { console.error('Error sending email:', emailError); return res.status(500).json({ success: false, action: 'email', message: 'Failed to send.' });}
  } else {
    console.error(`Unknown contactFormAction: ${contactFormActionSetting}`);
    return res.status(500).json({ success: false, message: "Server error: Invalid contact action." });
  }
});

// --- Server Start ---
const SERVER_PORT = process.env.PORT || 3000;
app.listen(SERVER_PORT, () => {
  console.log(`Server is running on http://localhost:${SERVER_PORT}`);
  console.log(`Current NODE_ENV: ${process.env.NODE_ENV}`);
  if (process.env.NODE_ENV !== 'production') {
    console.log(`Admin default: ${process.env.ADMIN_USERNAME || 'admin'} / ${process.env.ADMIN_PASSWORD_PLAIN || 'password123'}`);
    console.log(`Session Secret: ${process.env.SESSION_SECRET ? 'From ENV' : 'Default (INSECURE!)'}`);
  }
});

// Graceful shutdown (optional, but good practice)
process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing SQLite database.');
  db.close((err) => {
    if (err) console.error("Error closing SQLite DB:", err.message);
    else console.log('SQLite database connection closed.');
    process.exit(0);
  });
});