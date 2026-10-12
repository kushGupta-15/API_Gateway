const express = require('express');
const crypto = require('crypto');
const morgan = require('morgan');
const helmet = require('helmet');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
require('dotenv').config();

const app = express();

app.use(helmet());
app.use(cors({
    origin: true,
    credentials: true,
    exposedHeaders: ['x-correlation-id', 'x-cache', 'X-Cache']
}));

// Distributed Tracing: Correlation ID Middleware
app.use((req, res, next) => {
    const correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();
    req.correlationId = correlationId;
    res.setHeader('x-correlation-id', correlationId);

    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[TRACING] [${correlationId}] ${req.method} ${req.originalUrl || req.url} - ${res.statusCode} (${duration}ms)`);
    });
    next();
});

const PORT = process.env.PORT || 3005;
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const BOOKING_SERVICE_URL = process.env.BOOKING_SERVICE_URL || 'http://localhost:3002';
const FLIGHT_SEARCH_SERVICE_URL = process.env.FLIGHT_SEARCH_SERVICE_URL || 'http://localhost:3000';
const REMINDER_SERVICE_URL = process.env.REMINDER_SERVICE_URL || 'http://localhost:3004';

const limiter = rateLimit({
	windowMs: 2 * 60 * 1000,
	max: 100, 
})

app.use(morgan('combined'));
app.use(limiter);

const proxyErrorHandler = (err, req, res) => {
    console.error('Proxy Error:', err.message);
    if (!res.headersSent) {
        res.status(503).json({
            success: false,
            message: 'Downstream service unavailable via gateway proxy',
            err: err.message
        });
    }
};

const authLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minute window
    max: 15, // limit each IP to 15 login requests per window
    message: {
        success: false,
        message: 'Too many authentication attempts from this IP, please try again after 5 minutes.'
    },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use('/authservice/api/v1/signin', authLimiter);

app.use('/authservice', createProxyMiddleware({
    target: AUTH_SERVICE_URL,
    changeOrigin: true,
    proxyTimeout: 5000,
    timeout: 5000,
    pathRewrite: { '^/authservice': '' },
    on: {
        proxyReq: (proxyReq, req) => {
            if (req.correlationId) {
                proxyReq.setHeader('x-correlation-id', req.correlationId);
            }
        },
        error: proxyErrorHandler
    }
}));

// Admin RBAC Guard: Protect mutation endpoints on /flightservice
app.use('/flightservice', async (req, res, next) => {
    // Allow public read operations (GET) and health/metrics probes
    if (req.method === 'GET' || req.path === '/health' || req.path === '/metrics') {
        return next();
    }

    const token = req.headers['x-access-token'];
    if (!token) {
        return res.status(401).json({
            success: false,
            message: 'Unauthorized: Authentication token required for flight operations.'
        });
    }

    try {
        const authRes = await axios.get(`${AUTH_SERVICE_URL}/api/v1/isauthenticated`, {
            headers: {
                'x-access-token': token,
                'x-correlation-id': req.correlationId
            },
            timeout: 3000
        });

        if (!authRes.data?.success) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized: Invalid or expired session token.'
            });
        }

        const userId = authRes.data.data;
        req.headers['x-user-id'] = String(userId);

        const adminRes = await axios.get(`${AUTH_SERVICE_URL}/api/v1/isAdmin?id=${userId}`, {
            headers: {
                'x-access-token': token,
                'x-correlation-id': req.correlationId
            },
            timeout: 3000
        });

        if (adminRes.data?.data === true) {
            next();
        } else {
            return res.status(403).json({
                success: false,
                message: 'Forbidden: Admin dispatcher privileges required to modify flight routes or airport hubs.'
            });
        }
    } catch (err) {
        console.error('[Gateway Admin Guard] Validation error:', err.message);
        return res.status(403).json({
            success: false,
            message: 'Forbidden: Unable to verify administrative dispatch authority.',
            err: err.message
        });
    }
});

app.use('/flightservice', createProxyMiddleware({
    target: FLIGHT_SEARCH_SERVICE_URL,
    changeOrigin: true,
    proxyTimeout: 5000,
    timeout: 5000,
    pathRewrite: { '^/flightservice': '' },
    on: {
        proxyReq: (proxyReq, req) => {
            if (req.correlationId) {
                proxyReq.setHeader('x-correlation-id', req.correlationId);
            }
            if (req.headers['x-user-id']) {
                proxyReq.setHeader('x-user-id', req.headers['x-user-id']);
            }
        },
        error: proxyErrorHandler
    }
}));

app.use('/reminderservice', createProxyMiddleware({
    target: REMINDER_SERVICE_URL,
    changeOrigin: true,
    proxyTimeout: 5000,
    timeout: 5000,
    pathRewrite: { '^/reminderservice': '' },
    on: {
        proxyReq: (proxyReq, req) => {
            if (req.correlationId) {
                proxyReq.setHeader('x-correlation-id', req.correlationId);
            }
        },
        error: proxyErrorHandler
    }
}));

app.use('/bookingservice', async (req, res, next) => {
    if (req.path === '/health' || req.path === '/metrics') {
        return next();
    }
    try {
        const response = await axios.get(`${AUTH_SERVICE_URL}/api/v1/isauthenticated`, {
            headers: {
                'x-access-token': req.headers['x-access-token'],
                'x-correlation-id': req.correlationId
            },
            timeout: 3000
        });
        if(response.data.success) {
            req.headers['x-user-id'] = String(response.data.data);
            try {
                const adminCheck = await axios.get(`${AUTH_SERVICE_URL}/api/v1/isAdmin?id=${response.data.data}`, {
                    headers: { 'x-access-token': req.headers['x-access-token'] },
                    timeout: 2000
                });
                req.headers['x-is-admin'] = adminCheck.data?.data ? 'true' : 'false';
            } catch (_) {
                req.headers['x-is-admin'] = 'false';
            }
            next();
        } else {
            return res.status(401).json({
                message: 'Unauthorised'
            });
        }
    } catch (error) {
        if (error.code === 'ECONNABORTED') {
            return res.status(504).json({
                message: 'Authentication request timed out after 3000ms'
            });
        }
        if (error.code === 'ECONNREFUSED') {
            return res.status(503).json({
                message: 'Authentication service temporarily unreachable'
            });
        }
        return res.status(401).json({
            message: 'Unauthorised'
        });
    }
});
app.use('/bookingservice', createProxyMiddleware({
    target: BOOKING_SERVICE_URL,
    changeOrigin: true,
    proxyTimeout: 5000,
    timeout: 5000,
    on: {
        proxyReq: (proxyReq, req) => {
            if (req.correlationId) {
                proxyReq.setHeader('x-correlation-id', req.correlationId);
            }
            if (req.headers['x-user-id']) {
                proxyReq.setHeader('x-user-id', req.headers['x-user-id']);
            }
            if (req.headers['x-is-admin']) {
                proxyReq.setHeader('x-is-admin', req.headers['x-is-admin']);
            }
        },
        error: proxyErrorHandler
    }
}));

app.get('/system/overview', async (req, res) => {
    const services = [
        { id: 'gateway', name: 'API Gateway', url: `http://localhost:${PORT}/metrics`, healthUrl: `http://localhost:${PORT}/health`, type: 'gateway' },
        { id: 'search', name: 'Flight Search Service', url: `${FLIGHT_SEARCH_SERVICE_URL}/metrics`, healthUrl: `${FLIGHT_SEARCH_SERVICE_URL}/health`, type: 'core' },
        { id: 'auth', name: 'Authentication Service', url: `${AUTH_SERVICE_URL}/metrics`, healthUrl: `${AUTH_SERVICE_URL}/health`, type: 'core' },
        { id: 'booking', name: 'Booking Service', url: `${BOOKING_SERVICE_URL}/metrics`, healthUrl: `${BOOKING_SERVICE_URL}/health`, type: 'core' },
        { id: 'reminder', name: 'Reminder Service', url: `${REMINDER_SERVICE_URL}/metrics`, healthUrl: `${REMINDER_SERVICE_URL}/health`, type: 'worker' }
    ];

    const results = await Promise.allSettled(
        services.map(async (s) => {
            const start = Date.now();
            try {
                const metricRes = await axios.get(s.url, { timeout: 2500 });
                let healthData = {};
                if (s.healthUrl) {
                    try {
                        const hRes = await axios.get(s.healthUrl, { timeout: 2500 });
                        healthData = hRes.data;
                    } catch (_) {}
                }
                return {
                    ...s,
                    status: 'UP',
                    latencyMs: Date.now() - start,
                    metrics: metricRes.data,
                    health: healthData
                };
            } catch (err) {
                return {
                    ...s,
                    status: 'DOWN',
                    latencyMs: Date.now() - start,
                    error: err.message
                };
            }
        })
    );

    const cluster = results.map(r => r.value || r.reason);
    return res.status(200).json({
        clusterStatus: cluster.every(c => c.status === 'UP') ? 'HEALTHY' : 'DEGRADED',
        timestamp: new Date().toISOString(),
        correlationId: req.correlationId,
        services: cluster
    });
});
app.get('/health', (req, res) => {
    return res.status(200).json({
        service: 'API_Gateway',
        status: 'UP',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});
app.get('/metrics', (req, res) => {
    const memory = process.memoryUsage();
    return res.status(200).json({
        service: 'API_Gateway',
        status: 'UP',
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        memory: {
            rssMb: +(memory.rss / (1024 * 1024)).toFixed(2),
            heapTotalMb: +(memory.heapTotal / (1024 * 1024)).toFixed(2),
            heapUsedMb: +(memory.heapUsed / (1024 * 1024)).toFixed(2)
        },
        nodeVersion: process.version
    });
});
app.get('/home', (req, res) => {
    return res.json({message: 'OK'});
});

app.listen(PORT, () => {
    console.log(`Server started at port ${PORT}`);
});