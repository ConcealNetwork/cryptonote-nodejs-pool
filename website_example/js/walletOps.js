/**
 * Wallet OPS Page Scripts
 *
 * Copyright (c) 2026, Conceal Network
 * All rights reserved.
 */

/**
 * Initialize page with config data
 **/
$(() => {
    // Set coin symbol from lastStats if available
    if (lastStats?.config?.symbol) {
        $('#coinSymbol').text(lastStats.config.symbol);
    }
});

/**
 * Get Status
 **/
$('#getStatusButton').click(async () => {
    clearMessage('get_status');
    showInfo('get_status', 'Getting status...');
    $('#getStatusResult').val('');

    try {
        const response = await fetch(`${api}/admin_wallet_ops`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            credentials: 'include',
            cache: 'no-cache',
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 10,
                method: 'getStatus',
            }),
        });

        if (!response.ok) {
            if (response.status === 401) {
                return;
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (data.error) {
            showError('get_status', `Error: ${data.error}`);
            $('#getStatusResult').val(JSON.stringify(data, null, 2));
            return;
        }

        // Display the result
        $('#getStatusResult').val(JSON.stringify(data, null, 2));
        showSuccess('get_status', 'Status retrieved successfully');
    } catch (error) {
        console.error('Error getting status:', error);
        showError('get_status', `Request failed: ${error.message}`);
    }
});

/**
 * Save
 **/
$('#saveButton').click(async () => {
    clearMessage('save');
    showInfo('save', 'Saving...');
    $('#saveResult').val('');

    try {
        const response = await fetch(`${api}/admin_wallet_ops`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            credentials: 'include',
            cache: 'no-cache',
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 17,
                method: 'save',
            }),
        });

        if (!response.ok) {
            if (response.status === 401) {
                return;
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (data.error) {
            showError('save', `Error: ${data.error}`);
            $('#saveResult').val(JSON.stringify(data, null, 2));
            return;
        }

        // Display the result
        $('#saveResult').val(JSON.stringify(data, null, 2));
        showSuccess('save', 'Save completed successfully');
    } catch (error) {
        console.error('Error saving:', error);
        showError('save', `Request failed: ${error.message}`);
    }
});

/**
 * Get Transactions
 **/
$('#getTransactionsButton').click(async () => {
    const blockCount = parseInt($('#blockCount').val(), 10);
    const firstBlockIndex = parseInt($('#firstBlockIndex').val(), 10);

    clearMessage('get_transactions');
    showInfo('get_transactions', 'Getting transactions...');
    $('#getTransactionsResult').val('');

    try {
        const response = await fetch(`${api}/admin_wallet_ops`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            credentials: 'include',
            cache: 'no-cache',
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 13,
                method: 'getTransactions',
                params: {
                    blockCount: blockCount,
                    firstBlockIndex: firstBlockIndex,
                },
            }),
        });

        if (!response.ok) {
            if (response.status === 401) {
                return;
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (data.error) {
            showError('get_transactions', `Error: ${data.error}`);
            $('#getTransactionsResult').val(JSON.stringify(data, null, 2));
            return;
        }

        // Display the result
        $('#getTransactionsResult').val(JSON.stringify(data, null, 2));
        showSuccess('get_transactions', 'Transactions retrieved successfully');
    } catch (error) {
        console.error('Error getting transactions:', error);
        showError('get_transactions', `Request failed: ${error.message}`);
    }
});
