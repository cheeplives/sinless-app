<?php
/**
 * homebrew-subscriptions.php — which public packs the member has enabled to
 * live-merge into their game data.
 *
 *   GET                → {subscriptions:[{id,name,owner,data,updated_at}]}
 *                        (full data of each subscribed pack that is STILL public;
 *                         dead subscriptions — pack deleted or made private — are
 *                         pruned opportunistically so the list is what actually merges)
 *   POST   ?id=<int>   → subscribe to a public pack
 *   DELETE ?id=<int>   → unsubscribe
 */
declare(strict_types=1);
require __DIR__ . '/lib.php';

require_method('GET', 'POST', 'DELETE');
$user = require_approved();
$uid  = (int) $user['id'];
$method = $_SERVER['REQUEST_METHOD'];
$id = isset($_GET['id']) ? (int) $_GET['id'] : 0;

if ($method === 'GET') {
  $st = db()->prepare(
    'SELECT p.id, p.name, p.data, u.display_name AS owner, UNIX_TIMESTAMP(p.updated_at) AS updated_at
     FROM homebrew_subscriptions s
     JOIN homebrew_packs p ON p.id = s.pack_id AND p.is_public = 1
     JOIN users u ON u.id = p.user_id
     WHERE s.user_id = ? ORDER BY u.display_name, p.name');
  $st->execute([$uid]);
  $out = [];
  foreach ($st->fetchAll() as $r) {
    $out[] = ['id' => (int) $r['id'], 'name' => $r['name'], 'owner' => $r['owner'],
              'data' => json_decode($r['data'], true) ?: (object) [], 'updated_at' => (int) $r['updated_at']];
  }
  // Prune subscriptions whose pack is gone or no longer public.
  db()->prepare(
    'DELETE s FROM homebrew_subscriptions s
     LEFT JOIN homebrew_packs p ON p.id = s.pack_id AND p.is_public = 1
     WHERE s.user_id = ? AND p.id IS NULL')->execute([$uid]);
  json_out(['subscriptions' => $out]);
}

require_csrf();
rate_limit('write', 'u' . $uid, 120, 60);
if ($id <= 0) json_error(400, 'bad_id');

if ($method === 'POST') {
  // Only subscribable if the pack exists AND is public.
  $chk = db()->prepare('SELECT 1 FROM homebrew_packs WHERE id = ? AND is_public = 1 LIMIT 1');
  $chk->execute([$id]);
  if ($chk->fetchColumn() === false) json_error(404, 'not_found');
  $st = db()->prepare('INSERT IGNORE INTO homebrew_subscriptions (user_id, pack_id) VALUES (?, ?)');
  $st->execute([$uid, $id]);
  json_out(['ok' => true, 'subscribed' => true]);
}

// DELETE — unsubscribe
$st = db()->prepare('DELETE FROM homebrew_subscriptions WHERE user_id = ? AND pack_id = ?');
$st->execute([$uid, $id]);
json_out(['ok' => true, 'subscribed' => false]);
