/**
 * Wallet Optimization Page Scripts
 */

/**
 * Initialize page with config data
 **/
$(() => {
    // Set coin symbol from lastStats if available
    if (lastStats?.config?.symbol) {
        $('#coinSymbol').text(lastStats.config.symbol);
    }
    
    // Load initial wallet balance (will also populate pool address)
    refreshWalletBalance();
});

/**
 * Refresh Wallet Balance
 **/
async function refreshWalletBalance() {
    clearMessage('wallet_balance');
    showInfo('wallet_balance', 'Loading wallet balance...');
    
    try {
        const response = await fetch(`${api}/admin_wallet_balance`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            cache: 'no-cache'
        });
        
        if (!response.ok) {
            if (response.status === 401) {
                return;
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data.error) {
            showError('wallet_balance', `Error: ${data.error}`);
            return;
        }
        
        if (data.availableBalance !== undefined) {
            // Get coin units and decimals from lastStats
            const coinUnits = (lastStats?.config?.coinUnits) ? lastStats.config.coinUnits : 1000000;
            const coinDecimals = (lastStats?.config?.coinDecimalPlaces) ? lastStats.config.coinDecimalPlaces : 6;
            
            const balance = parseFloat(data.availableBalance) / coinUnits;
            $('#walletBalance').val(balance.toFixed(coinDecimals));
            
            // Also populate pool address if returned
            if (data.address) {
                $('#poolAddress').val(data.address);
            }
            
            showSuccess('wallet_balance', 'Balance loaded successfully');
        } else {
            showError('wallet_balance', 'Invalid response from server');
        }
    } catch (error) {
        console.error('Error fetching wallet balance:', error);
        showError('wallet_balance', `Request failed: ${error.message}`);
    }
}

$('#refreshBalanceButton').click(() => {
    refreshWalletBalance();
});

/**
 * Estimate Fusion
 **/
$('#estimateFusionButton').click(async () => {
    const threshold = parseInt($('#estimateFusionThreshold').val(), 10);
    
    clearMessage('estimate_fusion');
    showInfo('estimate_fusion', 'Estimating fusion...');
    $('#estimateFusionResult').val('');
    
    try {
        const response = await fetch(`${api}/admin_estimate_fusion?threshold=${threshold}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            cache: 'no-cache'
        });
        
        if (!response.ok) {
            if (response.status === 401) {
                return;
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data.error) {
            showError('estimate_fusion', `Error: ${data.error}`);
            $('#estimateFusionResult').val(JSON.stringify(data, null, 2));
            return;
        }
        
        // Display the result
        $('#estimateFusionResult').val(JSON.stringify(data, null, 2));
        
        if (data.fusionReadyCount !== undefined) {
            showSuccess('estimate_fusion', `Estimation complete! ${data.fusionReadyCount} outputs can be fused at threshold ${threshold.toLocaleString()}`);
        } else {
            showSuccess('estimate_fusion', 'Estimation complete');
        }
    } catch (error) {
        console.error('Error estimating fusion:', error);
        showError('estimate_fusion', `Request failed: ${error.message}`);
    }
});

/**
 * Send Fusion Transaction
 **/
$('#sendFusionButton').click(async function() {
    const threshold = parseInt($('#sendFusionThreshold').val(), 10);
    
    if (!confirm(`Are you sure you want to send a fusion transaction with threshold ${threshold.toLocaleString()}?`)) {
        return;
    }
    
    clearMessage('send_fusion');
    showInfo('send_fusion', 'Sending fusion transaction... This may take a moment.');
    $('#sendFusionResult').val('');
    
    // Disable button during request
    const $button = $(this);
    $button.prop('disabled', true);
    
    try {
        const response = await fetch(`${api}/admin_send_fusion?threshold=${threshold}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            cache: 'no-cache'
        });
        
        if (!response.ok) {
            if (response.status === 401) {
                $button.prop('disabled', false);
                return;
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data.error) {
            showError('send_fusion', `Error: ${data.error}`);
            $('#sendFusionResult').val(JSON.stringify(data, null, 2));
        } else {
            // Display the result
            $('#sendFusionResult').val(JSON.stringify(data, null, 2));
            
            if (data.transactionHash) {
                showSuccess('send_fusion', `Fusion transaction sent successfully! Transaction hash: ${data.transactionHash}`);
            } else {
                showSuccess('send_fusion', 'Fusion transaction completed');
            }
        }
    } catch (error) {
        console.error('Error sending fusion transaction:', error);
        showError('send_fusion', `Request failed: ${error.message}`);
    } finally {
        $button.prop('disabled', false);
    }
});
