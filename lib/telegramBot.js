/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Telegram bot
 *
 * Author: Daniel Vandal
 **/

// Load required modules
const { Telegraf } = require('telegraf');

const timeAgo = require('time-ago');

const apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet, config.api);
const notifications = require('./notifications.js');
const utils = require('./utils.js');

// Initialize log system
const logSystem = 'telegramBot';
require('./exceptionWriter.js')(logSystem);

/**
 * Check telegram configuration
 **/

// Check bot settings
if (!config.telegram) {
    log('error', logSystem, 'Telegram is not enabled');
}
else if (!config.telegram.enabled) {
    log('error', logSystem, 'Telegram is not enabled');
}
else if (!config.telegram.token) {
    log('error', logSystem, 'No telegram token found in configuration');
}

// Bot commands
const botCommands = {
    stats: "/stats",
    report: "/report",
    notify: "/notify",
    blocks: "/blocks"
}

if (config.telegram.botCommands) {
    Object.assign(botCommands, config.telegram.botCommands);
}

// Telegram channel
const channel = config.telegram.channel.replace(/@/g, '') || '';

// Periodical channel statistics
const periodicalStats = (channel && config.telegram.channelStats && config.telegram.channelStats.enabled)
const statsInterval = (config.telegram.channelStats && config.telegram.channelStats.interval > 0) ? parseInt(config.telegram.channelStats.interval) : 0;
    
/**
 * Initialize new telegram bot
 **/

log('info', logSystem, 'Started');

const token = config.telegram.token;
const bot = new Telegraf(token);

/**
 * Periodical pool statistics
 **/

if (periodicalStats && statsInterval > 0 && channel) {
    log('info', logSystem, 'Sending pool statistics to telegram channel @%s each %d minutes', [channel, statsInterval]);
    setInterval(()=> { sendPoolStats('@'+channel); }, (statsInterval*60)*1000);
}

/**
 * Handle "/start" or "/help"
 **/
 
bot.command(['start', 'help'], (ctx) => {
    if (ctx.from.id != ctx.chat.id) return ;

    log('info', logSystem, 'Commands list request from @%s (%s)', [ctx.from.username, ctx.from.id]);

    const message = 'Hi @' + ctx.from.username + ',\n\n' +
                  'Here are the commands you can use:\n\n' +
                  'Pool statistics: ' + botCommands['stats'] + '\n' +
                  'Blocks notifications: ' + botCommands['blocks'] + '\n' +
                  'Miner statistics: ' + botCommands['report'] + ' _address_\n' +
                  'Miner notifications: ' + botCommands['notify'] + ' _address_\n\n' +
                  'Thank you!';

    ctx.reply(message, { parse_mode: 'Markdown' });
});

/**
 * Pool Statistics
 **/

bot.hears(new RegExp('^'+botCommands['stats']+'$', 'i'), (ctx) => {
    log('info', logSystem, 'Pool statistics request from @%s (%s)', [ctx.from.username, ctx.from.id]);
    sendPoolStats(ctx.chat.id);
});

function sendPoolStats(chatId) {
    apiInterfaces.pool('/stats', (error, stats) => {    
        if (error || !stats) {
            log('error', logSystem, 'Unable to get API data for stats: ' + error);
            return bot.telegram.sendMessage(chatId, 'Unable to get pool statistics. Please retry.');
        }

        const poolHost = config.poolHost || "Pool";
        const poolHashrate = utils.getReadableHashRate(stats.pool.hashrate);
        const poolMiners = stats.pool.miners || 0;
        const poolWorkers = stats.pool.workers || 0;
        const poolBlocks = stats.pool.totalBlocks || 0;
        const poolLastBlock = (stats.pool.lastBlockFound) ? timeAgo.ago(new Date(parseInt(stats.pool.lastBlockFound))) : 'Never';

        const networkHashrate = utils.getReadableHashRate(stats.network.difficulty / stats.config.coinDifficultyTarget);
        const networkDiff = stats.network.difficulty || 'N/A';
        const networkHeight = stats.network.height || 'N/A';
        const networkLastReward = utils.getReadableCoins(stats.lastblock.reward);
        const networkLastBlock = (stats.lastblock.timestamp) ? timeAgo.ago(new Date(parseInt(stats.lastblock.timestamp * 1000))) : 'Never';

        const currentEffort = stats.pool.roundHashes ? (stats.pool.roundHashes / stats.network.difficulty * 100).toFixed(1) + '%' : '0%';

        let response = '';
        response += '*' + poolHost + '*\n';
        response += 'Hashrate: ' + poolHashrate + '\n';
        response += 'Connected Miners: ' + poolMiners + '\n';
        response += 'Active Workers: ' + poolWorkers + '\n';
        response += 'Blocks Found: ' + poolBlocks + '\n';
        response += 'Last Block: ' + poolLastBlock + '\n';
        response += 'Current Effort: ' + currentEffort + '\n';
        response += '\n';
        response += '*Network*\n';
        response += 'Hashrate: ' +  networkHashrate + '\n';
        response += 'Difficulty: ' + networkDiff + '\n';
        response += 'Block Height: ' + networkHeight + '\n';
        response += 'Block Found: ' + networkLastBlock + '\n';
        response += 'Last Reward: ' + networkLastReward;

        return bot.telegram.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    });
}

/**
 * Miner Statistics
 **/

bot.hears(new RegExp('^'+botCommands['report']+'$', 'i'), (ctx) => {
    if (ctx.from.id != ctx.chat.id) return ;

    var apiRequest = '/get_telegram_notifications?chatId='+ctx.from.id+'&type=default';
    apiInterfaces.pool(apiRequest, (error, response) => {
        if (response.address) {
            sendMinerStats(ctx, response.address);
        } else {
            var message = 'To display miner report you need to specify the miner address on first request';
            ctx.reply(message, { parse_mode: 'Markdown' });
        }
    });
});

bot.hears(new RegExp('^'+botCommands['report']+' (.*)$', 'i'), (ctx) => {
    if (ctx.from.id != ctx.chat.id) return ;

    const match = ctx.message.text.match(new RegExp('^'+botCommands['report']+' (.*)$', 'i'));
    const address = (match && match[1]) ? match[1].trim() : '';
    if (!address || address == '') {
        return ctx.reply('No address specified!');
    }

    sendMinerStats(ctx, address);
});

function sendMinerStats(ctx, address) {
    log('info', logSystem, 'Miner report request from @%s (%s) for address: %s', [ctx.from.username, ctx.from.id, address]);
    apiInterfaces.pool('/stats_address?address='+address, (error, data) => {
        if (error || !data) {
            log('error', logSystem, 'Unable to get API data for miner stats: ' + error);
            return ctx.reply('Unable to get miner statistics. Please retry.');
        }
        if (!data.stats) {
            return ctx.reply('No miner statistics found for that address. Please check the address and try again.');
        }

        const minerHashrate = utils.getReadableHashRate(data.stats.hashrate);
        const minerBalance = utils.getReadableCoins(data.stats.balance);
        const minerPaid = utils.getReadableCoins(data.stats.paid);
        const minerLastShare = timeAgo.ago(new Date(parseInt(data.stats.lastShare * 1000)));

        let response = '*Report for ' + address.substring(0,7)+'...'+address.substring(address.length-7) + '*\n';
        response += 'Hashrate: ' + minerHashrate + '\n';
        response += 'Last share: ' + minerLastShare + '\n';
        response += 'Balance: ' + minerBalance + '\n';
        response += 'Paid: ' + minerPaid + '\n';
        if (data.workers && data.workers.length > 0) {
            let f = true;
            for (const i in data.workers) {
                if (!(data.workers[i] && data.workers[i].hashrate ) || data.workers[i].hashrate === 0) continue;
                if (f) {
                    response += '\n';
                    response += '*Active Workers*\n';
                }
                const workerName = data.workers[i].name;
                const workerHashrate = utils.getReadableHashRate(data.workers[i].hashrate);
                response += workerName + ': ' + workerHashrate + '\n';
                f = false;
            }
        }
        ctx.reply(response, { parse_mode: 'Markdown' });

        const apiRequest = '/set_telegram_notifications?chatId='+ctx.from.id+'&type=default&address='+address;
        apiInterfaces.pool(apiRequest, (error, response) => {});
    });
}

/**
 * Miner notifications
 **/

bot.hears(new RegExp('^'+botCommands['notify']+'$', 'i'), (ctx) => {
    if (ctx.from.id != ctx.chat.id) return ;

    const apiRequest = '/get_telegram_notifications?chatId='+ctx.from.id+'&type=default';
    apiInterfaces.pool(apiRequest, (error, response) => {
        if (response.address) {
            toggleMinerNotifications(ctx, response.address);
        } else {
            const message = 'To enable or disable notifications you need to specify the miner address on first request';
            ctx.reply(message, { parse_mode: 'Markdown' });
        }
    });
});

bot.hears(new RegExp('^'+botCommands['notify']+' (.*)$', 'i'), (ctx) => {
    if (ctx.from.id != ctx.chat.id) return ;

    const match = ctx.message.text.match(new RegExp('^'+botCommands['notify']+' (.*)$', 'i'));
    const address = (match && match[1]) ? match[1].trim() : '';
    if (!address || address == '') {
        return ctx.reply('No address specified!');
    }

    toggleMinerNotifications(ctx, address);
});

function toggleMinerNotifications(ctx, address) {
    const apiRequest = '/get_telegram_notifications?chatId='+ctx.from.id+'&type=miner&address='+address;
    apiInterfaces.pool(apiRequest, (error, response) => {
        if (response.chatId && response.chatId == ctx.from.id) {
            disableMinerNotifications(ctx, address);
        } else {
            enableMinerNotifications(ctx, address);
        }
    });
}

function enableMinerNotifications(ctx, address) {
    log('info', logSystem, 'Enable miner notifications to @%s (%s) for address: %s', [ctx.from.username, ctx.from.id, address]);
    const apiRequest = '/set_telegram_notifications?chatId='+ctx.from.id+'&type=miner&address='+address+'&action=enable';
    apiInterfaces.pool(apiRequest, (error, response) => {
        if (error) {
            log('error', logSystem, 'Unable to enable telegram notifications: ' + error);
            return ctx.reply('An error occurred. Please retry.');
        }
        if (response.status != 'done') {
            return ctx.reply(response.status);
        }

        ctx.reply('Miner notifications enabled for ' + address.substring(0,7)+'...'+address.substring(address.length-7));

        const apiRequest = '/set_telegram_notifications?chatId='+ctx.from.id+'&type=default&address='+address;
        apiInterfaces.pool(apiRequest, (error, response) => {});
    });
}

function disableMinerNotifications(ctx, address) {
    log('info', logSystem, 'Disable miner notifications to @%s (%s) for address: %s', [ctx.from.username, ctx.from.id, address]);
    const apiRequest = '/set_telegram_notifications?chatId='+ctx.from.id+'&type=miner&address='+address+'&action=disable';
    apiInterfaces.pool(apiRequest, (error, response) => {
        if (error) {
            log('error', logSystem, 'Unable to disable telegram notifications: ' + error);
            return ctx.reply('An error occurred. Please retry.');
        }
        if (response.status != 'done') {
            return ctx.reply(response.status);
        }

        ctx.reply('Miner notifications disabled for ' + address.substring(0,7)+'...'+address.substring(address.length-7));

        const apiRequest = '/set_telegram_notifications?chatId='+ctx.from.id+'&type=default&address='+address;
        apiInterfaces.pool(apiRequest, (error, response) => {});
    });
}

/**
 * Blocks notifications
 **/

bot.hears(new RegExp('^'+botCommands['blocks']+'$', 'i'), (ctx) => {
    if (ctx.from.id != ctx.chat.id) return ;
    toggleBlocksNotifications(ctx);
});

function toggleBlocksNotifications(ctx) {
    const apiRequest = '/get_telegram_notifications?chatId='+ctx.from.id+'&type=blocks';
    apiInterfaces.pool(apiRequest, (error, response) => {
        if (error) {
            return ctx.reply('An error occurred. Please retry.');
        }
        if (response.enabled) {
            disableBlocksNotifications(ctx);
        } else {
            enableBlocksNotifications(ctx);
        }
    });
}

function enableBlocksNotifications(ctx) {
    log('info', logSystem, 'Enable blocks notifications to @%s (%s)', [ctx.from.username, ctx.from.id]);
    const apiRequest = '/set_telegram_notifications?chatId='+ctx.from.id+'&type=blocks&action=enable';
    apiInterfaces.pool(apiRequest, (error, response) => {
        if (error) {
            log('error', logSystem, 'Unable to enable telegram notifications: ' + error);
            return ctx.reply('An error occurred. Please retry.');
        }
        if (response.status != 'done') {
            return ctx.reply(response.status);
        }
        return ctx.reply('Blocks notifications enabled');
    });
}

function disableBlocksNotifications(ctx) {
    log('info', logSystem, 'Disable blocks notifications to @%s (%s)', [ctx.from.username, ctx.from.id]);
    const apiRequest = '/set_telegram_notifications?chatId='+ctx.from.id+'&type=blocks&action=disable';
    apiInterfaces.pool(apiRequest, (error, response) => {
        if (error) {            
            log('error', logSystem, 'Unable to disable telegram notifications: ' + error);
            return ctx.reply('An error occurred. Please retry.');
        }
        if (response.status != 'done') {
            return ctx.reply(response.status);
        }
        return ctx.reply('Blocks notifications disabled');
    });
}

// Launch the bot
bot.launch();
