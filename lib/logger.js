/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Log system
 **/

// Load required modules


const fs = require('fs');
const util = require('util');
const dateFormat = require('dateformat');
const clc = require('cli-color');

/**
 * Initialize log system
 **/
 
// Set CLI colors
const severityMap = {
    'info': clc.blue,
    'warn': clc.yellow,
    'error': clc.red
};

// Set severity levels
const severityLevels = ['info', 'warn', 'error'];

// Set log directory
const logDir = config.logging.files.directory;

// Create log directory if not exists
if (!fs.existsSync(logDir)){
    fs.mkdirSync(logDir);
}

/**
 * Write log entries to file at specified flush interval
 **/ 
const pendingWrites = {};

setInterval(() => {
    for (const fileName in pendingWrites){
        const data = pendingWrites[fileName];
        fs.appendFile(fileName, data, (err) => {
            if (err) {
                console.log("Error writing log data to disk: %s", err);
            }
        });
        delete pendingWrites[fileName];
    }
}, config.logging.files.flushInterval * 1000);

/**
 * Add new log entry
 **/
global.log = (severity, system, text, data) => {

    const logConsole = severityLevels.indexOf(severity) >= severityLevels.indexOf(config.logging.console.level);
    const logFiles = severityLevels.indexOf(severity) >= severityLevels.indexOf(config.logging.files.level);

    if (!(logConsole || logFiles)) return;

    const time = dateFormat(new Date(), 'yyyy-mm-dd HH:MM:ss');
    let formattedMessage = text;

    if (data) {
        data.unshift(text);
        formattedMessage = util.format(...data);
    }

    if (logConsole){
        if (config.logging.console.colors)
            console.log(severityMap[severity](time) + clc.white.bold(` [${system}] `) + formattedMessage);
        else
            console.log(`${time} [${system}] ${formattedMessage}`);
    }


    if (logFiles) {
        const fileName = `${logDir}/${system}_${severity}.log`;
        const fileLine = `${time} ${formattedMessage}\n`;
        pendingWrites[fileName] = (pendingWrites[fileName] || '') + fileLine;
    }
};