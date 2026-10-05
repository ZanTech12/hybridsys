require('dotenv').config();

const express = require('express');
const prisma = require('../config/db');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

// Import the auth middleware
const { authenticateToken } = require('../middlewares/authMiddleware');

// Initialize Express App
const app = express();

// ===================================================================
// HELPER — Pick the first existing path
// ===================================================================
const firstExisting = (candidates, mustContain) =>
    candidates.find(p =>
        fs.existsSync(mustContain ? path.join(p, mustContain) : p)
    ) || null;


// ===================================================================
// 1. CORS CONFIGURATION
// ===================================================================

// CLIENT_URLS example in Vercel:
//
// https://okispecial.com.ng,https://www.okispecial.com.ng,http://localhost:3000
//
// IMPORTANT:
// No spaces are required, but .trim() below protects against them.

const allowedOrigins = process.env.CLIENT_URLS
    ? process.env.CLIENT_URLS
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean)
    : [
        'https://okispecial.com.ng',
        'https://www.okispecial.com.ng',
        'https://fountainhillsschools.com.ng',
        'https://www.fountainhillsschools.com.ng',
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:5173'
    ];

const corsOptions = {
    origin: function (origin, callback) {

        // -----------------------------------------------------------
        // Requests without an Origin
        // -----------------------------------------------------------
        // Allows:
        // - Postman
        // - server-to-server requests
        // - health checks
        // - some desktop/native clients
        if (!origin) {
            return callback(null, true);
        }


        // -----------------------------------------------------------
        // Development / local mode
        // -----------------------------------------------------------
        if (process.env.NODE_ENV !== 'production') {
            return callback(null, true);
        }


        // -----------------------------------------------------------
        // Explicitly allowed origins
        // -----------------------------------------------------------
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }


        // -----------------------------------------------------------
        // Allowed development domains
        // -----------------------------------------------------------
        if (
            origin.includes('lvh.me') ||
            origin.includes('nip.io')
        ) {
            return callback(null, true);
        }


        // -----------------------------------------------------------
        // Your production domains
        // -----------------------------------------------------------
        if (
            origin.includes('okispecial.com.ng') ||
            origin.includes('fountainhillsschools.com.ng')
        ) {
            return callback(null, true);
        }


        // -----------------------------------------------------------
        // Localhost / LAN devices
        // -----------------------------------------------------------
        try {
            const host = new URL(origin).hostname;

            if (
                host === 'localhost' ||
                host === '127.0.0.1' ||

                // 10.x.x.x
                /^10\./.test(host) ||

                // 192.168.x.x
                /^192\.168\./.test(host) ||

                // 172.16.x.x - 172.31.x.x
                /^172\.(1[6-9]|2\d|3[01])\./.test(host)
            ) {
                return callback(null, true);
            }

        } catch (error) {
            // Invalid origin
        }


        // -----------------------------------------------------------
        // Block everything else
        // -----------------------------------------------------------
        console.log(`🚫 Blocked by CORS: ${origin}`);

        return callback(new Error('Not allowed by CORS'));
    },

    methods: [
        'GET',
        'POST',
        'PUT',
        'DELETE',
        'PATCH',
        'OPTIONS'
    ],

    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'x-auth-token'
    ],

    credentials: true,

    // 204 is the normal response for a successful preflight.
    optionsSuccessStatus: 204
};


// Apply CORS BEFORE all routes
app.use(cors(corsOptions));


// IMPORTANT:
// Explicitly handle browser OPTIONS/preflight requests.
//
// This must be AFTER app.use(cors(...)) and BEFORE your routes.
app.options('*', cors(corsOptions));


// ===================================================================
// 2. GLOBAL MIDDLEWARES
// ===================================================================

app.use(express.json({
    limit: '50mb'
}));

app.use(express.urlencoded({
    extended: true,
    limit: '50mb'
}));


// ===================================================================
// STATIC ADMIN PAGES
// ===================================================================

const publicDir = firstExisting([
    path.join(__dirname, 'public'),
    path.join(__dirname, '..', 'public')
]);

if (publicDir) {
    app.use(express.static(publicDir));
}


// ===================================================================
// SERVE REACT FRONTEND — STATIC FILES
// ===================================================================

const frontendBuild = firstExisting([
    path.join(__dirname, '..', 'cschoolexam', 'build'),
    path.join(__dirname, '..', '..', 'cschoolexam', 'build')
], 'index.html');

if (frontendBuild) {
    app.use(express.static(frontendBuild));
}


// ===================================================================
// SPA ROUTES
// ===================================================================

const SPA_ROUTES = [
    '/login',
    '/admin',
    '/teacher',
    '/student',
    '/register'
];

if (frontendBuild) {

    app.use((req, res, next) => {

        if (
            req.method === 'GET' &&
            (req.headers.accept || '').includes('text/html')
        ) {

            const matchesSpa = SPA_ROUTES.some(route =>
                req.path === route ||
                req.path.startsWith(route + '/')
            );

            if (matchesSpa) {
                return res.sendFile(
                    path.join(frontendBuild, 'index.html')
                );
            }
        }

        next();
    });
}


// ===================================================================
// HEALTH CHECK
// ===================================================================

app.get('/api/health', (req, res) => {

    res.status(200).json({
        success: true,
        status: 'ok',
        message: 'Server is online'
    });

});


// ===================================================================
// SECURE STATIC FILE SERVING FOR UPLOADS
// ===================================================================

const uploadsDir = firstExisting([
    path.join(__dirname, 'uploads'),
    path.join(__dirname, '..', 'uploads')
]) || path.join(__dirname, '..', 'uploads');

app.use(
    '/uploads',
    authenticateToken,
    (req, res) => {

        const resolvedRoot = path.resolve(uploadsDir);

        const filePath = path.resolve(
            uploadsDir,
            '.' + req.path
        );

        // Prevent path traversal
        if (
            filePath !== resolvedRoot &&
            !filePath.startsWith(resolvedRoot + path.sep)
        ) {
            return res.status(403).json({
                success: false,
                message: 'Forbidden'
            });
        }

        res.sendFile(filePath, err => {

            if (err) {

                console.error(
                    'File send error:',
                    err
                );

                if (!res.headersSent) {
                    res.status(404).json({
                        success: false,
                        message: 'File not found'
                    });
                }
            }
        });
    }
);


// ===================================================================
// 3. DATABASE CONNECTION
// ===================================================================

async function connectDB() {

    try {

        await prisma.$connect();

        console.log(
            '✅ PostgreSQL Database connected successfully!'
        );

    } catch (err) {

        console.error(
            '❌ PostgreSQL Connection Error:',
            err
        );

        process.exit(1);
    }
}


// ===================================================================
// 4. IMPORT ROUTES
// ===================================================================

const authRoutes = require('../routes/authRoutes');
const superAdminRoutes = require('../routes/superAdminRoutes');
const dashboardRoutes = require('../routes/dashboardRoutes');
const teacherRoutes = require('../routes/teacherRoutes');
const subjectRoutes = require('../routes/subjectRoutes');
const classRoutes = require('../routes/classRoutes');
const studentRoutes = require('../routes/studentRoutes');
const studentFeesRoutes = require('../routes/studentFeesRoutes');
const studentTestRoutes = require('../routes/studentTestRoutes');
const testRoutes = require('../routes/testRoutes');
const testResultRoutes = require('../routes/testResultRoutes');
const questionSetRoutes = require('../routes/questionSetRoutes');
const studentSubmissionRoutes = require('../routes/studentSubmissionRoutes');
const questionUploadRoutes = require('../routes/questionUploadRoutes');
const classTeacherCommentRoutes = require('../routes/classTeacherCommentRoutes');
const teacherAssignmentRoutes = require('../routes/teacherAssignmentRoutes');
const principalCommentRoutes = require('../routes/principalCommentRoutes');
const teacherCommentRoutes = require('../routes/teacherCommentRoutes');
const sessionRoutes = require('../routes/sessionRoutes');
const termRoutes = require('../routes/termRoutes');
const gradingSystemRoutes = require('../routes/gradingSystemRoutes');
const continuousAssessmentRoutes = require('../routes/continuousAssessmentRoutes');
const adminUtilityRoutes = require('../routes/adminUtilityRoutes');
const adminCaRoutes = require('../routes/adminCaRoutes');
const analyticsRoutes = require('../routes/analyticsRoutes');
const diagnosticRoutes = require('../routes/diagnosticRoutes');
const attendanceRoutes = require('../routes/attendanceRoutes');
const reportCardRoutes = require('../routes/reportCardRoutes');
const publicRoutes = require('../routes/publicRoutes');
const studentResultRoutes = require('../routes/studentResultRoutes');
const adminStudentBlockRoutes = require('../routes/adminStudentBlockRoutes');
const siteInfoRoutes = require('../routes/siteInformationRoutes');
const resultScheduleRoutes = require('../routes/resultScheduleRoutes');
const broadsheetRoutes = require('../routes/broadsheetRoutes');
const adminCaManagementRoutes = require('../routes/adminCaManagementRoutes');
const adminScoresRoutes = require('../routes/adminScoresRoutes');
const scoreManagementRoutes = require('../routes/scoreManagementRoutes');
const eNoteRoutes = require('../routes/eNoteRoutes');
const resultPinRoutes = require('../routes/resultPinRoutes');


// ===================================================================
// 5. MOUNT ROUTES
// ===================================================================

// Root endpoint
if (!frontendBuild) {

    app.get('/', (req, res) => {

        res.json({
            success: true,
            message: 'School Management API is running...'
        });

    });
}


// -------------------------------------------------------------------
// Authentication
// -------------------------------------------------------------------

app.use('/login', authRoutes);


// -------------------------------------------------------------------
// Super Admin
// -------------------------------------------------------------------

app.use('/superadmin', superAdminRoutes);


// -------------------------------------------------------------------
// Main application routes
// -------------------------------------------------------------------

app.use('/dashboard', dashboardRoutes);

app.use('/teachers', teacherRoutes);

app.use('/subjects', subjectRoutes);

app.use('/classes', classRoutes);

app.use('/students', studentRoutes);

app.use('/students', studentFeesRoutes);

app.use('/student', studentTestRoutes);

app.use('/tests', testRoutes);

app.use('/test-results', testResultRoutes);

app.use('/question-sets', questionUploadRoutes);

app.use('/question-sets', questionSetRoutes);

app.use('/student-submissions', studentSubmissionRoutes);

app.use(
    '/class-teacher-comments',
    classTeacherCommentRoutes
);

app.use(
    '/teacher-assignments',
    teacherAssignmentRoutes
);

app.use(
    '/principal-comments',
    principalCommentRoutes
);

app.use(
    '/teacher-comments',
    teacherCommentRoutes
);

app.use('/sessions', sessionRoutes);

app.use('/terms', termRoutes);

app.use(
    '/grading-systems',
    gradingSystemRoutes
);

app.use(
    '/continuous-assessments',
    continuousAssessmentRoutes
);

app.use('/attendance', attendanceRoutes);

app.use('/report-cards', reportCardRoutes);

app.use('/api', analyticsRoutes);

app.use('/public', publicRoutes);

app.use(
    '/result-schedules',
    resultScheduleRoutes
);

app.use('/e-notes', eNoteRoutes);


// ===================================================================
// SPECIFIC ADMIN ROUTES
// ===================================================================

app.use('/admin/ca', adminCaRoutes);

app.use(
    '/admin/result-pins',
    resultPinRoutes
);


// ===================================================================
// DATABASE SYNC ROUTE
// ===================================================================

const getPGBinDir = () => {

    // 1. Explicit override
    if (process.env.PG_BIN_PATH) {
        return process.env.PG_BIN_PATH;
    }


    // 2. Electron packaged application
    if (process.resourcesPath) {

        const bundled = path.join(
            process.resourcesPath,
            'postgres',
            'bin'
        );

        if (
            fs.existsSync(
                path.join(
                    bundled,
                    'pg_dump.exe'
                )
            )
        ) {
            return bundled;
        }
    }


    // 3. Repo-local PostgreSQL
    const localCandidates = [

        path.join(
            __dirname,
            '..',
            'resources',
            'postgres',
            'bin'
        ),

        path.join(
            __dirname,
            '..',
            '..',
            'resources',
            'postgres',
            'bin'
        )

    ];


    for (const dir of localCandidates) {

        if (
            fs.existsSync(
                path.join(
                    dir,
                    'pg_dump.exe'
                )
            )
        ) {
            return dir;
        }
    }


    // 4. Windows machine installation
    return 'C:\\Program Files\\PostgreSQL\\18\\bin';
};


const PG_BIN_DIR = getPGBinDir();

const PG_DUMP_PATH = path.join(
    PG_BIN_DIR,
    'pg_dump.exe'
);

const PG_RESTORE_PATH = path.join(
    PG_BIN_DIR,
    'pg_restore.exe'
);

console.log(
    `🛠️ PostgreSQL tools directory: ${PG_BIN_DIR}`
);


// -------------------------------------------------------------------
// Parse PostgreSQL connection URL
// -------------------------------------------------------------------

const parseConn = (urlStr) => {

    const u = new URL(urlStr);

    return {
        host: u.hostname,
        port: u.port || 5432,
        user: u.username,
        password: decodeURIComponent(u.password),
        database: u.pathname.slice(1)
    };
};


// -------------------------------------------------------------------
// Sync route
// -------------------------------------------------------------------

app.post(
    '/sync/:direction',
    authenticateToken,
    async (req, res) => {

        try {

            if (
                !['admin', 'superadmin']
                    .includes(req.user.role)
            ) {

                return res.status(403).json({
                    success: false,
                    message: 'Access denied. Admins only.'
                });
            }


            const direction = req.params.direction;

            const LOCAL_URL =
                process.env.DATABASE_URL;

            const ONLINE_URL =
                process.env.ONLINE_DATABASE_URL;


            if (!LOCAL_URL || !ONLINE_URL) {

                return res.status(500).json({
                    success: false,
                    message:
                        'Local or online database URL not configured.'
                });
            }


            // Vercel does not have the Windows PostgreSQL tools.
            if (
                !fs.existsSync(PG_DUMP_PATH) ||
                !fs.existsSync(PG_RESTORE_PATH)
            ) {

                return res.status(500).json({

                    success: false,

                    message:
                        `pg_dump/pg_restore not found in "${PG_BIN_DIR}". ` +
                        'Bundle PostgreSQL in resources/postgres or set PG_BIN_PATH.'
                });
            }


            // Server-Sent Events
            res.setHeader(
                'Content-Type',
                'text/event-stream'
            );

            res.setHeader(
                'Cache-Control',
                'no-cache'
            );

            res.setHeader(
                'Connection',
                'keep-alive'
            );


            const sendEvent = (message) => {

                res.write(
                    `data: ${JSON.stringify({
                        message
                    })}\n\n`
                );
            };


            const tempFile = path.join(
                os.tmpdir(),
                'temp_sync.dump'
            );


            let sourceConn;
            let targetConn;


            // -------------------------------------------------------
            // Determine sync direction
            // -------------------------------------------------------

            if (direction === 'to-local') {

                sourceConn =
                    parseConn(ONLINE_URL);

                targetConn =
                    parseConn(LOCAL_URL);

                sendEvent(
                    'Starting backup from Neon Cloud...'
                );

            } else if (direction === 'to-online') {

                sourceConn =
                    parseConn(LOCAL_URL);

                targetConn =
                    parseConn(ONLINE_URL);

                sendEvent(
                    'Starting push from Local Database...'
                );

            } else {

                return res.end();
            }


            // -------------------------------------------------------
            // pg_dump
            // -------------------------------------------------------

            const dumpArgs = [

                `--host=${sourceConn.host}`,

                `--port=${sourceConn.port}`,

                `--username=${sourceConn.user}`,

                `--dbname=${sourceConn.database}`,

                '--format=c',

                `--file=${tempFile}`

            ];


            const dump = spawn(
                PG_DUMP_PATH,
                dumpArgs,
                {
                    env: {
                        ...process.env,
                        PGPASSWORD:
                            sourceConn.password
                    }
                }
            );


            dump.stderr.on(
                'data',
                data => {

                    const msg =
                        data.toString();

                    if (
                        !msg
                            .toLowerCase()
                            .includes('warning')
                    ) {
                        sendEvent(
                            `Dumping: ${msg.trim()}`
                        );
                    }
                }
            );


            dump.on(
                'error',
                err => {

                    sendEvent(
                        `❌ Spawn Error: ${err.message}`
                    );

                    res.end();
                }
            );


            dump.on(
                'close',
                code => {

                    if (code !== 0) {

                        sendEvent(
                            '❌ Error: Failed to dump database.'
                        );

                        if (
                            fs.existsSync(tempFile)
                        ) {
                            fs.unlinkSync(tempFile);
                        }

                        return res.end();
                    }


                    sendEvent(
                        '✅ Dump complete. Starting restore...'
                    );


                    // -------------------------------------------------
                    // pg_restore
                    // -------------------------------------------------

                    const restoreArgs = [

                        `--host=${targetConn.host}`,

                        `--port=${targetConn.port}`,

                        `--username=${targetConn.user}`,

                        `--dbname=${targetConn.database}`,

                        '--clean',

                        '--if-exists',

                        '--no-owner',

                        '--no-privileges',

                        tempFile

                    ];


                    const restore = spawn(
                        PG_RESTORE_PATH,
                        restoreArgs,
                        {
                            env: {
                                ...process.env,
                                PGPASSWORD:
                                    targetConn.password
                            }
                        }
                    );


                    restore.stderr.on(
                        'data',
                        data => {

                            const msg =
                                data.toString();

                            sendEvent(
                                `Restore Log: ${msg.trim()}`
                            );
                        }
                    );


                    restore.stdout.on(
                        'data',
                        data => {

                            const msg =
                                data.toString();

                            sendEvent(
                                `Restore Log: ${msg.trim()}`
                            );
                        }
                    );


                    restore.on(
                        'close',
                        code => {

                            if (
                                code === 0 ||
                                code === 1
                            ) {

                                sendEvent(
                                    '✅ Synchronization completed successfully!'
                                );

                            } else {

                                sendEvent(
                                    `❌ Error: Failed to restore database. Exit code: ${code}`
                                );
                            }


                            if (
                                fs.existsSync(tempFile)
                            ) {
                                fs.unlinkSync(tempFile);
                            }

                            res.end();
                        }
                    );


                    restore.on(
                        'error',
                        err => {

                            sendEvent(
                                `❌ Spawn Error: ${err.message}`
                            );

                            res.end();
                        }
                    );
                }
            );

        } catch (error) {

            console.error(
                'Sync error:',
                error.message
            );

            if (!res.headersSent) {

                return res.status(500).json({
                    success: false,
                    message: 'Server error'
                });
            }


            res.write(
                `data: ${JSON.stringify({
                    message: '❌ Server error'
                })}\n\n`
            );

            res.end();
        }
    }
);


// ===================================================================
// GENERIC ADMIN ROUTE
// ===================================================================

app.use(
    '/admin',
    adminUtilityRoutes
);


// ===================================================================
// ROOT-MOUNTED ROUTES
// ===================================================================

app.use(
    '/',
    diagnosticRoutes
);

app.use(
    '/',
    studentResultRoutes
);

app.use(
    '/site-information',
    siteInfoRoutes
);

app.use(
    '/',
    adminStudentBlockRoutes
);

app.use(
    '/',
    broadsheetRoutes
);

app.use(
    '/',
    adminCaManagementRoutes
);

app.use(
    '/',
    adminScoresRoutes
);

app.use(
    '/',
    scoreManagementRoutes
);


// ===================================================================
// SPA FALLBACK
// ===================================================================

if (frontendBuild) {

    app.use((req, res, next) => {

        if (
            req.method === 'GET' &&
            (req.headers.accept || '')
                .includes('text/html')
        ) {

            return res.sendFile(
                path.join(
                    frontendBuild,
                    'index.html'
                )
            );
        }

        next();
    });
}


// ===================================================================
// 6. GLOBAL ERROR HANDLER
// ===================================================================

// 404
app.use((req, res, next) => {

    res.status(404).json({

        success: false,

        message: 'Route not found'

    });
});


// Global errors
app.use((err, req, res, next) => {

    console.error(
        'Global Error:',
        err.stack
    );

    res.status(
        err.status || 500
    ).json({

        success: false,

        message:
            err.message ||
            'Internal Server Error'

    });
});


// ===================================================================
// 7. AUTOMATIC SUPERADMIN INITIALIZATION
// ===================================================================

const initializeSuperAdmin = async () => {

    try {

        const username =
            process.env.SUPERADMIN_USERNAME ||
            'superadmin';

        const email =
            process.env.SUPERADMIN_EMAIL ||
            'superadmin@yourschool.com';

        const password =
            process.env.SUPERADMIN_PASSWORD ||
            'SuperSecretPassword123';


        const superAdminExists =
            await prisma.superAdmin.findUnique({
                where: {
                    username
                }
            });


        if (!superAdminExists) {

            const salt =
                await bcrypt.genSalt(10);

            const hashedPassword =
                await bcrypt.hash(
                    password,
                    salt
                );


            await prisma.superAdmin.create({

                data: {

                    username,

                    email,

                    password:
                        hashedPassword
                }

            });


            console.log(
                '✅ Default SuperAdmin created successfully!'
            );
        }

    } catch (error) {

        console.error(
            '❌ Error initializing SuperAdmin:',
            error.message
        );
    }
};


// ===================================================================
// 8. START SERVER LOCALLY / EXPORT FOR VERCEL
// ===================================================================

const isServerless =
    !!process.env.VERCEL;


if (!isServerless) {

    const PORT =
        process.env.PORT || 5000;


    connectDB()
        .then(async () => {

            await initializeSuperAdmin();


            try {

                app.listen(
                    PORT,
                    () => {

                        console.log(
                            `🚀 Server running in ${
                                process.env.NODE_ENV ||
                                'development'
                            } mode on port ${PORT}`
                        );

                        console.log(
                            `🌐 Allowed CORS Origins: ${
                                allowedOrigins.join(', ')
                            }`
                        );
                    }
                );

            } catch (err) {

                console.error(
                    `❌ Failed to start server on port ${PORT}:`,
                    err.message
                );
            }

        })
        .catch(err => {

            console.error(
                '❌ Failed to connect to database or start server:',
                err
            );
        });


    process.on(
        'exit',
        code => {

            console.log(
                `\n⚠️ Process is exiting with code: ${code}`
            );
        }
    );


    process.on(
        'uncaughtException',
        err => {

            console.error(
                '❌ UNCAUGHT EXCEPTION:',
                err
            );
        }
    );


    process.on(
        'unhandledRejection',
        reason => {

            console.error(
                '❌ UNHANDLED REJECTION:',
                reason
            );
        }
    );


    // Keep Node process alive for desktop/LAN server
    setInterval(
        () => {},
        1000
    );

} else {

    console.log(
        '☁️ Serverless (Vercel) mode — app exported; Prisma connects lazily.'
    );
}


// ===================================================================
// EXPORT EXPRESS APP FOR VERCEL
// ===================================================================

module.exports = app;
