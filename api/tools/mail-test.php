<?php
/**
 * tools/mail-test.php — CLI-only diagnostic for the approval/revoke email.
 *
 * Run it from the site directory on the server:
 *   php api/tools/mail-test.php you@example.com
 *
 * It prints which config file lib.php actually loaded, whether the
 * approval_email block is switched on, and the result of a real mail() send —
 * so you can tell config problems apart from delivery (SPF/DKIM/spam) problems.
 *
 * Refuses to run over the web (returns 404): it must never be an open relay.
 */
declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

require __DIR__ . '/../lib.php';

$to = $argv[1] ?? '';
if ($to === '' || !filter_var($to, FILTER_VALIDATE_EMAIL)) {
  fwrite(STDERR, "Usage: php api/tools/mail-test.php <recipient@example.com>\n");
  exit(1);
}

$cfg = (array) cfg('approval_email', []);
echo "Config file loaded  : " . ($GLOBALS['__CONFIG_PATH'] ?? '(unknown)') . "\n";
echo "  (if this isn't the file you edited, edit THIS one — first match wins)\n";
echo "enabled             : " . var_export($cfg['enabled'] ?? null, true) . "\n";
echo "from                : " . var_export($cfg['from'] ?? null, true) . "\n";
echo "base_url            : " . var_export(cfg('base_url'), true) . "\n";
echo "mail() available    : " . (function_exists('mail') ? 'yes' : 'NO — disabled on this host') . "\n\n";

if (empty($cfg['enabled']) || empty($cfg['from'])) {
  echo "RESULT: email is OFF. Set approval_email.enabled = true and a 'from' address\n"
     . "        in the config file named above, then re-run this test.\n";
  exit(2);
}

$from = (string) $cfg['from'];
$envelope = $from;
if (preg_match('/<([^>]+)>/', $from, $m)) $envelope = $m[1];

$headers = implode("\r\n", [
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=UTF-8',
  'From: ' . $from,
]);
$params = filter_var($envelope, FILTER_VALIDATE_EMAIL) ? '-f' . $envelope : '';
$ok = @mail($to, 'Sinless mail test',
  "This is a Sinless mail-test message. If you received it, mail() works.\n",
  $headers, $params);

echo "envelope sender (-f): " . var_export($params, true) . "\n";
echo "mail() returned     : " . var_export($ok, true) . "\n\n";
echo $ok
  ? "RESULT: mail() accepted the message. If it never arrives it's a DELIVERY issue —\n"
    . "        SPF/DKIM misalignment, spam filtering, or the From domain's email isn't\n"
    . "        hosted on this server. Check the recipient's spam folder and\n"
    . "        ~/logs/<domain>/https/error.log, and make sure 'from' is on a domain\n"
    . "        this host is authorized to send for.\n"
  : "RESULT: mail() returned FALSE — the local mailer rejected it. On DreamHost this\n"
    . "        usually means mail() is restricted for this domain; use an SMTP relay,\n"
    . "        or send From a domain whose email is hosted on this account.\n";
