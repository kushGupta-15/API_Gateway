const express = require('express');
const morgan = require('morgan');
const { createProxyMiddleware } = require('http-proxy-middleware');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
require('dotenv').config();

const app = express();

const PORT = process.env.PORT || 3005;
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const BOOKING_SERVICE_URL = process.env.BOOKING_SERVICE_URL || 'http://localhost:3002';

const limiter = rateLimit({
	windowMs: 2 * 60 * 1000,
	max: 5, 
})

app.use(morgan('combined'));
app.use(limiter);
app.use('/bookingservice', async (req, res, next) => {
    console.log(req.headers['x-access-token']);
    try {
        const response = await axios.get(`${AUTH_SERVICE_URL}/api/v1/isauthenticated`, {
            headers: {
                'x-access-token': req.headers['x-access-token']
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
            if (req.headers['x-user-id']) {
                proxyReq.setHeader('x-user-id', req.headers['x-user-id']);
            }
        }
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
app.get('/home', (req, res) => {
    return res.json({message: 'OK'});
});

app.listen(PORT, () => {
    console.log(`Server started at port ${PORT}`);
});