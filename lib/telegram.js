/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Telegram notifications system
 *
 * Author: Daniel Vandal
 **/

// Load required modules
// fetch is available globally in Node.js 18+

// Initialize log system
const logSystem = 'telegram';
require('./exceptionWriter.js')(logSystem);

/**
 * Send telegram message
 **/
exports.sendMessage = async (chatId, messageText) => {
    // Return error if no text content
    if (!messageText) {
        log('warn', logSystem, 'No text to send.');
        return;
    }

    // Check telegram configuration
    if (!config.telegram) {
        log('error', logSystem, 'Telegram is not configured!');
        return;
    }
    
    // Do nothing if telegram is disabled
    if (!config.telegram.enabled) return;
    
    // Telegram bot token
    const token = config.telegram.token || '';
    if (!token || token === '') {
        log('error', logSystem, 'No telegram token specified in configuration!');
        return;
    }
    
    // Telegram chat id
    if (!chatId || chatId === '' || chatId === '@') {
        log('error', logSystem, 'No telegram chat id specified!');
        return;
    }

    // Set telegram API URL
    const action = 'sendMessage';
    const apiURL = `https://api.telegram.org/bot${token}/${action}`;
    
    const params = new URLSearchParams({
        chat_id: chatId,
        text: messageText,
        parse_mode: 'Markdown'
    });

    try {
        const response = await fetch(`${apiURL}?${params.toString()}`);
        
        if (!response.ok) {
            log('error', logSystem, 'Telegram request failed: HTTP %s', [response.status]);
            return;
        }

        const data = await response.json();

        if (data && !data.ok) {
            log('error', logSystem, 'Telegram API error: [%s] %s', [data.error_code, data.description]);
            return;
        }
        log('info', logSystem, 'Telegram message sent to %s: %s', [chatId, messageText]);
    } catch (error) {
        log('error', logSystem, 'Telegram request failed: %s', [error.message]);
    }
}
