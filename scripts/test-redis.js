#!/usr/bin/env node
/**
 * Quick Redis connectivity test script
 * Tests if Redis is accessible and working
 */

const redis = require('redis');

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const REDIS_AUTH = process.env.REDIS_AUTH || null;

async function testRedis() {
    console.log(`Testing Redis connection to ${REDIS_HOST}:${REDIS_PORT}...`);
    
    const client = redis.createClient({
        socket: {
            host: REDIS_HOST,
            port: REDIS_PORT
        },
        password: REDIS_AUTH || undefined
    });

    try {
        // Connect to Redis
        await client.connect();
        console.log('✓ Redis connection successful');

        // Test PING
        const pong = await client.ping();
        console.log(`✓ Redis PING: ${pong}`);

        // Test SET/GET
        const testKey = 'pool_test_' + Date.now();
        await client.set(testKey, 'test_value');
        const value = await client.get(testKey);
        console.log(`✓ Redis SET/GET test: ${value === 'test_value' ? 'PASSED' : 'FAILED'}`);

        // Clean up
        await client.del(testKey);
        console.log('✓ Redis cleanup successful');

        // Get Redis info
        const info = await client.info('server');
        const version = info.match(/redis_version:([^\r\n]+)/)?.[1] || 'unknown';
        console.log(`✓ Redis version: ${version}`);

        console.log('\n✅ All Redis tests passed!');
        await client.quit();
        process.exit(0);
    } catch (error) {
        console.error('\n❌ Redis test failed:');
        console.error(`   Error: ${error.message}`);
        console.error('\nTroubleshooting:');
        console.error('   1. Make sure Redis is installed: sudo apt install redis-server');
        console.error('   2. Make sure Redis is running: redis-server');
        console.error('   3. Check Redis port: redis-cli ping');
        console.error(`   4. Verify connection: redis-cli -h ${REDIS_HOST} -p ${REDIS_PORT} ping`);
        await client.quit().catch(() => {});
        process.exit(1);
    }
}

testRedis();
