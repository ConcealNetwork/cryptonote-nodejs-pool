/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Log system
 **/

// Load required modules
const fs = require('node:fs');
const util = require('node:util');
const path = require('node:path');
const dateFormat = require('dateformat');
const clc = require('cli-color');

/**
 * Initialize log system
 **/

// Define logging severity levels (ordered by severity)
const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
};

// Map string levels to numeric values
const levelMap = {
    'debug': LOG_LEVELS.DEBUG,
    'info': LOG_LEVELS.INFO,
    'warn': LOG_LEVELS.WARN,
    'error': LOG_LEVELS.ERROR
};

// Set CLI colors
const severityMap = {
    'debug': clc.cyan,
    'info': clc.blue,
    'warn': clc.yellow,
    'error': clc.red
};

// Get log directory from environment variable or config
const logDir = process.env.LOG_DIR || config.logging.files.directory;

// Create log directory if not exists
if (!fs.existsSync(logDir)) {
    try {
        fs.mkdirSync(logDir, { recursive: true });
    } catch (err) {
        console.error(`Failed to create log directory ${logDir}: ${err.message}`);
        process.exit(1);
    }
}

/**
 * Write log entries to file at specified flush interval
 **/
const pendingWrites = {};
let writeErrors = 0;
const MAX_WRITE_ERRORS = 10;

const flushInterval = (process.env.LOG_FLUSH_INTERVAL 
    ? parseInt(process.env.LOG_FLUSH_INTERVAL, 10) 
    : config.logging.files.flushInterval) * 1000;

setInterval(() => {
    for (const fileName in pendingWrites) {
        const data = pendingWrites[fileName];
        if (!data) {
            delete pendingWrites[fileName];
            continue;
        }
        
        fs.appendFile(fileName, data, (err) => {
            if (err) {
                writeErrors++;
                console.error(`Error writing log data to disk (${writeErrors}/${MAX_WRITE_ERRORS}): ${err.message}`);
                console.error(`Failed file: ${fileName}`);
                
                // Prevent error spam - only log first few errors
                if (writeErrors >= MAX_WRITE_ERRORS) {
                    console.error('Too many log write errors. Check disk space and permissions.');
                    writeErrors = 0; // Reset counter after warning
                }
            } else {
                // Reset error counter on successful write
                if (writeErrors > 0) {
                    writeErrors = 0;
                }
            }
        });
        delete pendingWrites[fileName];
    }
}, flushInterval);

/**
 * Check if severity level should be logged
 * @param {string} severity - Log severity level
 * @param {string} configuredLevel - Configured minimum level
 * @returns {boolean} True if should log
 */
const shouldLog = (severity, configuredLevel) => {
    const severityLevel = levelMap[severity.toLowerCase()] ?? LOG_LEVELS.INFO;
    const configuredLevelNum = levelMap[configuredLevel?.toLowerCase()] ?? LOG_LEVELS.INFO;
    return severityLevel >= configuredLevelNum;
};

/**
 * Format log message using util.format
 * @param {string} text - Base message text
 * @param {Array} data - Additional data to format
 * @returns {string} Formatted message
 */
const formatMessage = (text, data) => {
    if (!data || data.length === 0) {
        return text;
    }
    
    // util.format expects format string as first arg, then values
    // If data is an array, spread it; otherwise use as-is
    try {
        return util.format(text, ...data);
    } catch {
        // Fallback if formatting fails
        return `${text} ${JSON.stringify(data)}`;
    }
};

/**
 * Add new log entry
 * @param {string} severity - Log severity ('debug', 'info', 'warn', 'error')
 * @param {string} system - System/module name
 * @param {string} text - Log message (can contain format specifiers)
 * @param {Array} data - Optional data array for util.format
 */
global.log = (severity, system, text, data) => {
    // Normalize severity
    let normalizedSeverity = severity?.toLowerCase() ?? 'info';
    
    // Validate severity - check if key exists in levelMap (not the value, since DEBUG=0 is falsy)
    if (!(normalizedSeverity in levelMap)) {
        console.error(`Invalid log severity: ${severity}. Using 'info' instead.`);
        normalizedSeverity = 'info';
    }

    // Check if should log to console
    const consoleLevel = process.env.LOG_CONSOLE_LEVEL || config.logging.console.level;
    const logConsole = shouldLog(normalizedSeverity, consoleLevel);
    
    // Check if should log to files
    const fileLevel = process.env.LOG_FILE_LEVEL || config.logging.files.level;
    const logFiles = shouldLog(normalizedSeverity, fileLevel);

    if (!(logConsole || logFiles)) return;

    const time = dateFormat(new Date(), 'yyyy-mm-dd HH:MM:ss');
    const formattedMessage = formatMessage(text, data);

    if (logConsole) {
        const useColors = process.env.LOG_COLORS !== 'false' && config.logging.console.colors;
        
        if (useColors && severityMap[normalizedSeverity]) {
            const coloredTime = severityMap[normalizedSeverity](time);
            const coloredSystem = clc.white.bold(` [${system}] `);
            console.log(coloredTime + coloredSystem + formattedMessage);
        } else {
            console.log(`${time} [${system}] ${formattedMessage}`);
        }
    }

    if (logFiles) {
        const fileName = path.join(logDir, `${system}_${normalizedSeverity}.log`);
        const fileLine = `${time} ${formattedMessage}\n`;
        
        // Accumulate writes for batching
        pendingWrites[fileName] = (pendingWrites[fileName] || '') + fileLine;
    }
};