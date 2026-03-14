/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Email system
 * Supports: sendmail, smtp, mailgun
 *
 * Author: Daniel Vandal
 **/

// Load required modules
const nodemailer = require('nodemailer');
const mailgun = require('mailgun.js');

// Initialize log system
const logSystem = 'email';
require('./exceptionWriter.js')(logSystem);

/**
 * Sends out an email
 **/
exports.sendEmail = (email, subject, content) => {
    // Return error if no destination email address
    if (!email) {
        log('warn', logSystem, 'Unable to send e-mail: no destination email.');
    	return ;
    }

    // Check email system configuration
    if (!config.email) {
        log('error', logSystem, 'Email system not configured!');
    	return ;
    }
	
    // Do nothing if email system is disabled
    if (!config.email.enabled) return ;

    // Set content data
    const messageData = {
        from: config.email.fromAddress,
        to: email,
        subject: subject,
        text: content
    };
    
    // Get email transport
    const transportMode = config.email.transport;
    const transportCfg = config.email[transportMode] ? config.email[transportMode] : {};
    
    if (transportMode === "mailgun") {
        const mg = mailgun.client({username: 'api', key: transportCfg.key});
        mg.messages.create(transportCfg.domain, messageData);
        log('info', logSystem, 'E-mail sent to %s: %s', [messageData.to, messageData.subject]);
    }
    
    else {
        transportCfg['transport'] = transportMode;
        const transporter = nodemailer.createTransport(transportCfg);
        transporter.sendMail(messageData, function(error){
            if(error){
                log('error', logSystem, 'Unable to send e-mail to %s: %s', [messageData.to, error.toString()]);
            } else {
                log('info', logSystem, 'E-mail sent to %s: %s', [email, subject]);
            }
        });	
    }
};
