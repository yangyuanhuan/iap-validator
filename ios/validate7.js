const config = require('../config.js');
const log = require('../log.js');

const iap = require('in-app-purchase');
const express = require('express');

const router = express.Router();

function findLatestReceipt(productID, receipts) {
  let finalReceipt = null;
  let latestTime = 0;
  let type = '';

  receipts.forEach((receipt) => {
    if (!Object.prototype.hasOwnProperty.call(receipt, 'product_id')
     || !Object.prototype.hasOwnProperty.call(receipt, 'transaction_id')
     || !Object.prototype.hasOwnProperty.call(receipt, 'original_transaction_id')
     || !Object.prototype.hasOwnProperty.call(receipt, 'original_purchase_date_ms')) {
      throw new Error('Fail to parsing Apple receipt.');
    }

    if (receipt.product_id !== productID) {
      return true;
    }

    // Subsription
    if (Object.prototype.hasOwnProperty.call(receipt, 'expires_date_ms')) {
      const time = parseInt(receipt.expires_date_ms, 10);
      if (time > latestTime) {
        finalReceipt = receipt;
        latestTime = time;
      }
      type = 'subscription';
    } else if (Object.prototype.hasOwnProperty.call(receipt, 'purchase_date_ms')) { // IAP
      const time = parseInt(receipt.purchase_date_ms, 10);
      if (time > latestTime) {
        finalReceipt = receipt;
        latestTime = time;
      }
      type = 'iap';
    }

    return true;
  });

  return { receipt: finalReceipt, latest_ms: latestTime, type };
}

router.get('/:bundle/:receipt/:product_id', (req, res) => {
  // Config IAP.
  if (config.IOS[req.params.bundle] === 'undefined') {
    // Invalid configuration.
    log('iOS configuration error.');
    res.end(JSON.stringify({
      code: 102,
      error: 'Configuration error.',
    }));
    return;
  }
  iap.config(config.IOS[req.params.bundle]);

  // Set up response.
  res.writeHead(200, { 'Content-Type': 'application/json' });

  // Set up IAP.
  iap.setup((error) => {
    if (error) {
      // Fail to set up IAP.
      log(`iOS initialization error: ${error}`);
      res.end(JSON.stringify({
        code: 102,
        error: `Initialization error: ${error.toString()}`,
      }));
      return;
    }

    // Validate the IAP.
    iap.validate(iap.APPLE, req.params.receipt, (appleErr, reply) => {
      if (appleErr) {
        // Error from Apple.
        try {
          log(`iOS verification failed: ${appleErr.toString()}`);
          if (appleErr.message === 'failed to validate for empty purchased list') {
            res.end(JSON.stringify({
              code: 201,
              status: reply.status,
              message: 'the receipt is valid, but purchased nothing',
              product_original_purchase_date_ms:
                  reply.receipt ? reply.receipt.original_purchase_date_ms : 0,
              download_id: reply.receipt ? reply.receipt.download_id.toString() : '',
            }));
          } else {
            res.end(JSON.stringify({
              code: 101,
              status: reply.status,
              receipt: JSON.stringify(reply),
              error: `Verification failed: ${appleErr.toString()}`,
            }));
          }
        } catch (exception) {
          log(`iOS parsing receipt failed: ${JSON.stringify(reply)}`);
          res.end(JSON.stringify({
            code: 103,
            error: `Verification and parsing receipt failed: ${appleErr.toString()} ${JSON.stringify(reply)}`,
          }));
        }
        return;
      }

      if (iap.isValidated(reply)) {
        try {
          // Purchase.
          if (!Object.prototype.hasOwnProperty.call(reply, 'receipt')
           || !Object.prototype.hasOwnProperty.call(reply.receipt, 'bundle_id')
           || !Object.prototype.hasOwnProperty.call(reply.receipt, 'in_app')) {
            throw new Error('Fail to parsing Apple receipt.');
          }

          let finalReceipt = null;
          let latestTime = 0;
          let type = '';

          // Handle 'latest_receipt_info', deprecated field
          if (Object.prototype.hasOwnProperty.call(reply, 'latest_receipt_info')) {
            const output = findLatestReceipt(req.params.product_id, reply.latest_receipt_info);
            finalReceipt = output.receipt;
            latestTime = output.latest_ms;
            type = output.type;
          }

          // Handle 'in_app'
          const output = findLatestReceipt(req.params.product_id, reply.receipt.in_app);
          if (output.latest_ms > latestTime) {
            finalReceipt = output.receipt;
            latestTime = output.latest_ms;
            type = output.type;
          }

          if (!finalReceipt) {
            log(`iOS iap product ${req.params.product_id} not found in receitpt: ${JSON.stringify(reply)}`);
            res.end(JSON.stringify({
              code: 202,
              status: reply.status,
              message: `the receipt is valid, but target product_id not found: ${req.params.product_id}`,
              product_original_purchase_date_ms:
                  reply.receipt ? reply.receipt.original_purchase_date_ms : 0,
              download_id: reply.receipt ? reply.receipt.download_id.toString() : '',
            }));
            return;
          }

          let isTrialPeriod = false;
          if (Object.prototype.hasOwnProperty.call(finalReceipt, 'is_trial_period')) {
            isTrialPeriod = !!JSON.parse(finalReceipt.is_trial_period);
          }

          res.end(JSON.stringify({
            code: 0,
            platform: 'iOS',
            type,
            app_id: reply.receipt.bundle_id,
            product_id: finalReceipt.product_id,
            status: reply.status,
            transaction_id: finalReceipt.transaction_id,
            original_transaction_id: finalReceipt.original_transaction_id,
            developer_payload: '',
            purchase_state: 0,
            consumption_state: 0,
            auto_renewing: false,
            price_currency_code: '',
            price_amount_micros: 0,
            country_code: '',
            payment_state: 0,
            cancel_reason: 0,
            is_trial_period: isTrialPeriod,
            original_purchase_date: parseInt(finalReceipt.original_purchase_date_ms, 10),
            expires_date: ((type === 'subscription') ? latestTime : 0),
            product_original_purchase_date_ms: reply.receipt.original_purchase_date_ms,
            download_id: reply.receipt.download_id.toString(),
          }));

          if (config.DEBUG) {
            log(`iOS7 success receipt log: ${JSON.stringify(reply)}`);
          }
        } catch (err) {
          log(`iOS parsing receipt failed: ${JSON.stringify(reply)}`);
          res.end(JSON.stringify({
            code: 103,
            receipt: JSON.stringify(reply),
            error: `Parsing receipt failed (${err.toString()}).`,
          }));
        }
      } else {
        // Validation failed.
        log(`Validation failed: ${JSON.stringify(reply)}`);
        res.end(JSON.stringify({
          code: 104,
          status: reply.status,
          receipt: JSON.stringify(reply),
          error: 'Validation failed.',
        }));
      }
    });
  });
});

module.exports = router;
