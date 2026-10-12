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
app.use(cors());

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
        },
        error: proxyErrorHandler
    }
}));

app.use('/bookingservice', async (req, res, next) => {
    console.log(req.headers['x-access-token']);
    try {
        const response = await axios.get(`${AUTH_SERVICE_URL}/api/v1/isauthenticated`, {
            headers: {
                'x-access-token': req.headers['x-access-token'],
                'x-correlation-id': req.correlationId
            },
            timeout: 3000
        });
        console.log(response.data);
        if(response.data.success) {
            req.headers['x-user-id'] = response.data.data;
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
})
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
        },
        error: proxyErrorHandler
    }
}));
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