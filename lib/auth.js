/**
 * Cryptonote Node.JS Pool
 * Authentication & Authorization Module
 * 
 * Handles all authentication, authorization, and security-related functions
 **/

const crypto = require('crypto');
const url = require('url');

// Rate limiting store
const rateLimitStore = new Map();

class AuthManager {
    constructor(config, log, logSystem) {
        this.config = config;
        this.log = log;
        this.logSystem = logSystem;
        
        // JWT secret is ALWAYS required (no development bypass)
        if (!config.api?.jwtSecret) {
            throw new Error('jwtSecret is required in config.json under api.jwtSecret. Run: node scripts/generate-jwt-secret.js');
        }
        this.jwtSecret = config.api.jwtSecret;
        
        this.corsOrigin = config.api?.frontendUrl || '*';
        
        // Enforce HTTPS in production
        if (process.env.NODE_ENV === 'production' && !config.api?.ssl?.enabled) {
            throw new Error('HTTPS (SSL) must be enabled in production. Set api.ssl.enabled=true in config.json or change NODE_ENV.');
        }
        
        // Rate limit settings
        this.rateLimitWindow = 60 * 1000; // 1 minute
        this.rateLimitMaxAttempts = 5;
        this.rateLimitBlockDuration = 15 * 60 * 1000; // 15 minutes
        
        // Start cleanup interval
        this.startCleanupInterval();
    }

    /**
     * Start cleanup interval for rate limit store
     */
    startCleanupInterval() {
        setInterval(() => {
            const now = Date.now();
            for (const [ip, record] of rateLimitStore.entries()) {
                // Remove entries that are no longer blocked and past their reset time
                if ((!record.blockedUntil || now > record.blockedUntil) && now > record.resetTime) {
                    rateLimitStore.delete(ip);
                }
            }
        }, 5 * 60 * 1000); // Cleanup every 5 minutes
    }

    /**
     * Check rate limit for IP and endpoint
     * @param {string} ip - Client IP address
     * @param {string} endpoint - API endpoint being accessed
     * @returns {Object} Rate limit status
     */
    checkRateLimit(ip, endpoint) {
        const now = Date.now();
        const key = `${ip}:${endpoint}`;
        
        let record = rateLimitStore.get(key);
        
        if (!record) {
            record = {
                attempts: 0,
                resetTime: now + this.rateLimitWindow,
                blockedUntil: null,
                blocked: false
            };
            rateLimitStore.set(key, record);
        }
        
        // Check if currently blocked
        if (record.blockedUntil && now < record.blockedUntil) {
            const remainingSeconds = Math.ceil((record.blockedUntil - now) / 1000);
            return {
                allowed: false,
                blocked: true,
                remainingSeconds,
                message: `Too many attempts. Try again in ${remainingSeconds} seconds.`
            };
        }
        
        // Reset counter if window expired
        if (now > record.resetTime) {
            record.attempts = 0;
            record.resetTime = now + this.rateLimitWindow;
            record.blockedUntil = null;
            record.blocked = false;
        }
        
        // Increment attempts
        record.attempts++;
        
        // Check if exceeded limit
        if (record.attempts > this.rateLimitMaxAttempts) {
            record.blockedUntil = now + this.rateLimitBlockDuration;
            record.blocked = true;
            const remainingSeconds = Math.ceil(this.rateLimitBlockDuration / 1000);
            
            this.log('warn', this.logSystem, 'Rate limit exceeded for %s on %s - blocked for %d seconds', [ip, endpoint, remainingSeconds]);
            
            return {
                allowed: false,
                blocked: true,
                remainingSeconds,
                message: `Too many attempts. Blocked for ${remainingSeconds} seconds.`
            };
        }
        
        return {
            allowed: true,
            blocked: false,
            attemptsRemaining: this.rateLimitMaxAttempts - record.attempts
        };
    }

    /**
     * Hash password using PBKDF2-SHA512 with salt
     * @param {string} password - Plain text password
     * @returns {string} Hashed password in format $pbkdf2$iterations$salt$hash
     */
    hashPassword(password) {
        const iterations = 100000;
        const salt = crypto.randomBytes(32).toString('hex');
        const hash = crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512').toString('hex');
        return `$pbkdf2$${iterations}$${salt}$${hash}`;
    }

    /**
     * Verify password against stored hash (PBKDF2 only)
     * @param {string} password - Plain text password to verify
     * @param {string} storedHash - Stored hash from database
     * @returns {boolean} True if password matches
     */
    verifyPassword(password, storedHash) {
        if (!storedHash || !password) {
            return false;
        }

        // Only accept PBKDF2 format
        if (!storedHash.startsWith('$pbkdf2$')) {
            this.log('error', this.logSystem, 'Invalid password format - only PBKDF2 hashes are accepted');
            return false;
        }

        try {
            const parts = storedHash.split('$');
            if (parts.length !== 5 || parts[1] !== 'pbkdf2') {
                return false;
            }

            const iterations = parseInt(parts[2], 10);
            const salt = parts[3];
            const hash = parts[4];

            const verifyHash = crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512').toString('hex');
            
            return this.timingSafeCompare(hash, verifyHash);
        } catch (error) {
            this.log('error', this.logSystem, 'Error verifying password: %j', [error]);
            return false;
        }
    }

    /**
     * Timing-safe string comparison to prevent timing attacks
     * @param {string} a - First string
     * @param {string} b - Second string
     * @returns {boolean} True if strings match
     */
    timingSafeCompare(a, b) {
        if (typeof a !== 'string' || typeof b !== 'string') {
            return false;
        }

        // Ensure both strings are same length for crypto.timingSafeEqual
        const aBuffer = Buffer.from(a, 'utf8');
        const bBuffer = Buffer.from(b, 'utf8');

        if (aBuffer.length !== bBuffer.length) {
            // Still do a comparison to prevent timing attacks on length
            const dummyBuffer = Buffer.alloc(aBuffer.length);
            crypto.timingSafeEqual(aBuffer, dummyBuffer);
            return false;
        }

        try {
            return crypto.timingSafeEqual(aBuffer, bBuffer);
        } catch (error) {
            return false;
        }
    }

    /**
     * Create JWT token
     * @param {Object} payload - Data to encode in JWT
     * @param {number} expiresInMinutes - Token expiration time
     * @returns {string} JWT token
     */
    createJWT(payload, expiresInMinutes = 10) {
        const header = { alg: 'HS256', typ: 'JWT' };
        const now = Math.floor(Date.now() / 1000);
        const exp = now + (expiresInMinutes * 60);

        const jwtPayload = {
            ...payload,
            iat: now,
            exp: exp
        };

        const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
        const encodedPayload = Buffer.from(JSON.stringify(jwtPayload)).toString('base64url');
        const signature = crypto.createHmac('sha256', this.jwtSecret)
            .update(`${encodedHeader}.${encodedPayload}`)
            .digest('base64url');

        return `${encodedHeader}.${encodedPayload}.${signature}`;
    }

    /**
     * Verify JWT token
     * @param {string} token - JWT token to verify
     * @returns {Object|null} Decoded payload or null if invalid
     */
    verifyJWT(token) {
        if (!token) return null;

        try {
            const parts = token.split('.');
            if (parts.length !== 3) return null;

            const [encodedHeader, encodedPayload, signature] = parts;

            // Verify signature
            const expectedSignature = crypto.createHmac('sha256', this.jwtSecret)
                .update(`${encodedHeader}.${encodedPayload}`)
                .digest('base64url');

            if (!this.timingSafeCompare(signature, expectedSignature)) {
                return null;
            }

            // Decode payload
            const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));

            // Check expiration
            const now = Math.floor(Date.now() / 1000);
            if (payload.exp && payload.exp < now) {
                return null; // Token expired
            }

            return payload;
        } catch (error) {
            this.log('error', this.logSystem, 'Error verifying JWT: %j', [error]);
            return null;
        }
    }

    /**
     * Get security headers including CSP
     * @param {boolean} allowInlineScripts - Allow inline scripts (needed for some pages)
     * @returns {Object} Security headers
     */
    getSecurityHeaders(allowInlineScripts = false) {
        const scriptSrc = allowInlineScripts ? "'self' 'unsafe-inline'" : "'self'";
        return {
            'X-Frame-Options': 'DENY',
            'X-Content-Type-Options': 'nosniff',
            'X-XSS-Protection': '1; mode=block',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
            'Content-Security-Policy': `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'`,
            'Cache-Control': 'no-store, no-cache, must-revalidate, private',
            'Pragma': 'no-cache',
            'Expires': '0'
        };
    }
    
    /**
     * Get remote IP address from request
     * @param {Object} request - HTTP request object
     * @returns {string} IP address
     */
    getRemoteAddress(request) {
        return request.headers['x-forwarded-for']?.split(',')[0].trim() ||
               request.connection?.remoteAddress ||
               request.socket?.remoteAddress ||
               'unknown';
    }

    /**
     * Parse cookies from request
     * @param {Object} request - HTTP request object
     * @returns {Object} Parsed cookies
     */
    parseCookies(request) {
        const cookies = {};
        const cookieHeader = request.headers.cookie;

        if (cookieHeader) {
            cookieHeader.split(';').forEach(cookie => {
                const parts = cookie.trim().split('=');
                if (parts.length === 2) {
                    cookies[parts[0]] = decodeURIComponent(parts[1]);
                }
            });
        }

        return cookies;
    }

    /**
     * Authorize request using JWT from Authorization header or cookie
     * Supports both modern (Authorization header) and legacy (cookie) authentication
     * @param {Object} request - HTTP request object
     * @param {Object} response - HTTP response object
     * @returns {boolean} True if authorized
     */
    authorize(request, response) {
        let token = null;
        
        // 1. Check Authorization header first (more secure, CSRF-resistant)
        const authHeader = request.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.substring(7);
            this.log('debug', this.logSystem, 'Using Authorization header for authentication');
        }
        
        // 2. Fallback to cookie for backward compatibility
        if (!token) {
            const cookies = this.parseCookies(request);
            token = cookies.jwtToken;
            if (token) {
                this.log('debug', this.logSystem, 'Using cookie for authentication');
            }
        }

        if (!token) {
            this.log('debug', this.logSystem, 'No authentication token found');
            response.writeHead(401, {
                ...this.getSecurityHeaders(),
                'Access-Control-Allow-Origin': this.corsOrigin,
                'Access-Control-Allow-Credentials': 'true',
                'Content-Type': 'application/json',
            });
            response.end(JSON.stringify({ error: 'Unauthorized - No token provided' }));
            return false;
        }

        const payload = this.verifyJWT(token);
        if (!payload) {
            this.log('debug', this.logSystem, 'JWT verification failed');
            response.writeHead(401, {
                ...this.getSecurityHeaders(),
                'Access-Control-Allow-Origin': this.corsOrigin,
                'Access-Control-Allow-Credentials': 'true',
                'Content-Type': 'application/json',
            });
            response.end(JSON.stringify({ error: 'Unauthorized - Invalid or expired token' }));
            return false;
        }

        return true;
    }

    /**
     * Handle admin login
     * @param {Object} request - HTTP request object
     * @param {Object} response - HTTP response object
     */
    async handleAdminLogin(request, response) {
        const ip = this.getRemoteAddress(request);
        
        // Only accept POST requests
        if (request.method !== 'POST') {
            response.writeHead(405, {
                ...this.getSecurityHeaders(),
                'Access-Control-Allow-Origin': this.corsOrigin,
                'Access-Control-Allow-Credentials': 'true',
                'Content-Type': 'application/json',
            });
            response.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
            return;
        }
        
        // Read password from request body
        let sentPass;
        try {
            const body = await this.getRequestBody(request);
            const data = JSON.parse(body);
            sentPass = data.password;
        } catch (error) {
            response.writeHead(400, {
                ...this.getSecurityHeaders(),
                'Access-Control-Allow-Origin': this.corsOrigin,
                'Access-Control-Allow-Credentials': 'true',
                'Content-Type': 'application/json',
            });
            response.end(JSON.stringify({ error: 'Invalid request body' }));
            return;
        }

        // Check rate limit
        const rateLimit = this.checkRateLimit(ip, '/admin_login');
        if (!rateLimit.allowed) {
            response.writeHead(429, {
                ...this.getSecurityHeaders(),
                'Access-Control-Allow-Origin': this.corsOrigin,
                'Access-Control-Allow-Credentials': 'true',
                'Content-Type': 'application/json',
            });
            response.end(JSON.stringify({ 
                error: 'Too Many Requests',
                message: rateLimit.message,
                remainingSeconds: rateLimit.remainingSeconds
            }));
            return;
        }

        // Verify password
        const configPassword = this.config.api.password;
        if (!this.verifyPassword(sentPass, configPassword)) {
            this.log('warn', this.logSystem, 'Failed admin login attempt from %s', [ip]);
            response.writeHead(401, {
                ...this.getSecurityHeaders(),
                'Access-Control-Allow-Origin': this.corsOrigin,
                'Access-Control-Allow-Credentials': 'true',
                'Content-Type': 'application/json',
            });
            response.end(JSON.stringify({ error: 'Invalid password' }));
            return;
        }

        // Create JWT token
        const token = this.createJWT({ admin: true }, 10); // 10 minutes

        this.log('info', this.logSystem, 'Successful admin login from %s', [ip]);

        // Build secure cookie string
        // Note: Secure flag should be used in production with HTTPS
        // SameSite=Strict provides strong CSRF protection
        const isProduction = process.env.NODE_ENV === 'production';
        const secureCookie = [
            `jwtToken=${token}`,
            'HttpOnly',
            'SameSite=Strict',
            'Max-Age=600',
            'Path=/',
            // Add Secure flag if in production or if SSL is configured
            ...(isProduction || this.config.api?.ssl?.enabled ? ['Secure'] : [])
        ].join('; ');

        response.writeHead(200, {
            ...this.getSecurityHeaders(),
            'Access-Control-Allow-Origin': this.corsOrigin,
            'Access-Control-Allow-Credentials': 'true',
            'Content-Type': 'application/json',
            'Set-Cookie': secureCookie,
        });
        // Token is in HttpOnly cookie only - not exposed in response body
        response.end(JSON.stringify({ 
            success: true,
            expiresIn: 600 // 10 minutes in seconds
        }));
    }
    
    /**
     * Get request body as string
     * @param {Object} request - HTTP request object
     * @returns {Promise<string>} Request body
     */
    getRequestBody(request) {
        return new Promise((resolve, reject) => {
            let body = '';
            request.on('data', chunk => {
                body += chunk.toString();
                // Prevent body too large attacks (max 1KB for login)
                if (body.length > 1024) {
                    reject(new Error('Request body too large'));
                    request.connection.destroy();
                }
            });
            request.on('end', () => resolve(body));
            request.on('error', reject);
        });
    }

    /**
     * Handle admin logout - clear JWT cookie
     */
    handleAdminLogout(request, response) {
        this.log('info', this.logSystem, 'Admin logout requested');
        
        // Clear the HttpOnly JWT cookie by setting it to expire immediately
        const cookieOptions = [
            'jwtToken=',
            'Max-Age=0',
            'Path=/',
            'HttpOnly',
            'SameSite=Strict'
        ];
        
        // Add Secure flag in production
        if (process.env.NODE_ENV === 'production') {
            cookieOptions.push('Secure');
        }
        
        response.writeHead(200, {
            'Set-Cookie': cookieOptions.join('; '),
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': this.corsOrigin,
            'Access-Control-Allow-Credentials': 'true',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        
        response.end(JSON.stringify({ 
            success: true, 
            message: 'Logged out successfully' 
        }));
    }
}

module.exports = AuthManager;
