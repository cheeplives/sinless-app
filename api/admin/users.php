<?php
/**
 * admin/users.php — owner-only user administration.
 *   GET  [?status=pending]  → list users (default: all), newest first
 *   POST {user_id, action}  → action in {approve, revoke}
 * is_admin is deliberately NOT settable here — admins are seeded only via
 * $ADMIN_IDENTITIES in config.php.
 */
declare(strict_types=1);
require __DIR__ . '/../lib.php';

require_method('GET', 'POST');
$admin = require_admin();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  $status = $_GET['status'] ?? '';
  if ($status !== '' && !in_array($status, ['pending', 'approved', 'revoked'], true)) {
    json_error(400, 'bad_status');
  }
  if ($status !== '') {
    $st = db()->prepare(
      'SELECT id, provider, email, display_name, avatar_url, status, is_admin, created_at, approved_at
       FROM users WHERE status = ? ORDER BY created_at DESC');
    $st->execute([$status]);
  } else {
    $st = db()->query(
      'SELECT id, provider, email, display_name, avatar_url, status, is_admin, created_at, approved_at
       FROM users ORDER BY created_at DESC');
  }
  json_out(['users' => $st->fetchAll()]);
}

// POST — approve / revoke
require_csrf();
rate_limit('admin', 'u' . $admin['id'], 60, 60);   // 60 admin actions / min
$body = read_json_body(4096);
$targetId = (int) ($body['user_id'] ?? 0);
$action   = (string) ($body['action'] ?? '');
if ($targetId <= 0 || !in_array($action, ['approve', 'revoke'], true)) {
  json_error(400, 'bad_request');
}
if ($targetId === (int) $admin['id']) {
  json_error(400, 'cannot_modify_self');   // don't let an admin lock themselves out
}

// Read prior state first so we only email on an ACTUAL status transition
// (re-approving / re-revoking must not re-send).
$sel = db()->prepare('SELECT email, display_name, status, is_admin FROM users WHERE id = ?');
$sel->execute([$targetId]);
$target = $sel->fetch();
if (!$target) json_error(404, 'user_not_found');

if ($action === 'approve') {
  $st = db()->prepare("UPDATE users SET status = 'approved', approved_at = NOW() WHERE id = ?");
  $st->execute([$targetId]);

  if (($target['status'] ?? '') !== 'approved' && !empty($target['email'])) {
    send_account_email('approved', (string) $target['email'], (string) ($target['display_name'] ?? ''));
  }
} else {
  $st = db()->prepare("UPDATE users SET status = 'revoked' WHERE id = ? AND is_admin = 0");
  $st->execute([$targetId]);

  // The UPDATE no-ops on admins (is_admin = 0 guard); mirror that here so an
  // admin target is never emailed, and only send on a real transition.
  if (!(int) $target['is_admin'] && ($target['status'] ?? '') !== 'revoked' && !empty($target['email'])) {
    send_account_email('revoked', (string) $target['email'], (string) ($target['display_name'] ?? ''));
  }
}
json_out(['ok' => true]);
