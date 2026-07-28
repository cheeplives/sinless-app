<?php
/**
 * homebrew.php — named homebrew packs + members-only public sharing.
 *
 * Private (owner-scoped, WHERE user_id = session):
 *   GET                     → my packs [{id,name,is_public,data,updated_at}]
 *   POST   (no id)          → create {name,data?}          → {id}
 *   PUT    ?id=<int>        → save {name?,data}            (owner only; visibility untouched)
 *   POST   ?id=<int>        → toggle {is_public:bool}       (owner only)
 *   DELETE ?id=<int>
 *
 * Public (cross-user, hard-gated is_public=1 — still members-only login):
 *   GET ?public=1           → gallery [{id,name,owner,item_count,updated_at}]  (NO rows)
 *   GET ?public_id=<int>    → {id,name,owner,data,updated_at} if that pack is public
 */
declare(strict_types=1);
require __DIR__ . '/lib.php';

require_method('GET', 'POST', 'PUT', 'DELETE');
$user = require_approved();
$uid  = (int) $user['id'];
$method = $_SERVER['REQUEST_METHOD'];
$id = isset($_GET['id']) ? (int) $_GET['id'] : 0;

function pack_item_count($json): int {
  $d = json_decode((string) $json, true);
  if (!is_array($d)) return 0;
  $n = 0;
  foreach ($d as $rows) if (is_array($rows)) $n += count($rows);
  return $n;
}
function clean_pack_name($s): string {
  $s = trim((string) $s);
  if ($s === '') $s = 'Homebrew';
  return mb_substr($s, 0, 120);
}

if ($method === 'GET') {
  // --- gallery: metadata for every public pack, any owner (NO rows) ----------
  if (isset($_GET['public'])) {
    $st = db()->prepare(
      'SELECT p.id, p.name, u.display_name AS owner, p.data,
              UNIX_TIMESTAMP(p.updated_at) AS updated_at
       FROM homebrew_packs p JOIN users u ON u.id = p.user_id
       WHERE p.is_public = 1 ORDER BY u.display_name, p.name');
    $st->execute();
    $out = [];
    foreach ($st->fetchAll() as $r) {
      $out[] = ['id' => (int) $r['id'], 'name' => $r['name'], 'owner' => $r['owner'],
                'item_count' => pack_item_count($r['data']), 'updated_at' => (int) $r['updated_at']];
    }
    json_out(['packs' => $out]);
  }
  // --- fetch one public pack's full data by id, only if public ---------------
  if (isset($_GET['public_id'])) {
    $pid = (int) $_GET['public_id'];
    $st = db()->prepare(
      'SELECT p.id, p.name, p.data, u.display_name AS owner, UNIX_TIMESTAMP(p.updated_at) AS updated_at
       FROM homebrew_packs p JOIN users u ON u.id = p.user_id
       WHERE p.id = ? AND p.is_public = 1 LIMIT 1');
    $st->execute([$pid]);
    $row = $st->fetch();
    if (!$row) json_error(404, 'not_found');
    json_out(['id' => (int) $row['id'], 'name' => $row['name'], 'owner' => $row['owner'],
              'data' => json_decode($row['data'], true) ?: (object) [],
              'updated_at' => (int) $row['updated_at']]);
  }
  // --- my packs (with data) --------------------------------------------------
  $st = db()->prepare(
    'SELECT id, name, is_public, data, UNIX_TIMESTAMP(updated_at) AS updated_at
     FROM homebrew_packs WHERE user_id = ? ORDER BY name');
  $st->execute([$uid]);
  $out = [];
  foreach ($st->fetchAll() as $r) {
    $out[] = ['id' => (int) $r['id'], 'name' => $r['name'], 'is_public' => (bool) $r['is_public'],
              'data' => json_decode($r['data'], true) ?: (object) [], 'updated_at' => (int) $r['updated_at']];
  }
  json_out(['packs' => $out]);
}

// --- mutations: CSRF + write rate limit -------------------------------------
require_csrf();
rate_limit('write', 'u' . $uid, 120, 60);

// create (POST with no id)
if ($method === 'POST' && $id === 0) {
  $body = read_json_body((int) cfg('max_custom_bytes', 1048576));
  $name = clean_pack_name($body['name'] ?? 'Homebrew');
  $data = (isset($body['data']) && is_array($body['data'])) ? $body['data'] : (object) [];
  $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  $st = db()->prepare('INSERT INTO homebrew_packs (user_id, name, data) VALUES (?, ?, ?)');
  $st->execute([$uid, $name, $json]);
  json_out(['ok' => true, 'id' => (int) db()->lastInsertId(), 'name' => $name]);
}

if ($id <= 0) json_error(400, 'bad_id');

// toggle visibility (POST with id) — kept separate so a data save never flips sharing
if ($method === 'POST') {
  $body = read_json_body(1024);
  $isPublic = !empty($body['is_public']) ? 1 : 0;
  $st = db()->prepare('UPDATE homebrew_packs SET is_public = ? WHERE id = ? AND user_id = ?');
  $st->execute([$isPublic, $id, $uid]);
  json_out(['ok' => true, 'is_public' => (bool) $isPublic, 'updated' => $st->rowCount() > 0]);
}

if ($method === 'DELETE') {
  $st = db()->prepare('DELETE FROM homebrew_packs WHERE id = ? AND user_id = ?');
  $st->execute([$id, $uid]);
  json_out(['ok' => true, 'deleted' => $st->rowCount() > 0]);
}

// PUT — save name+data on your OWN pack (visibility untouched)
$body = read_json_body((int) cfg('max_custom_bytes', 1048576));
$data = $body['data'] ?? null;
if (!is_array($data)) json_error(400, 'missing_data');
$json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
if ($json === false) json_error(400, 'unserializable');
$fields = ['data = :data'];
$params = [':data' => $json, ':id' => $id, ':uid' => $uid];
if (isset($body['name'])) { $fields[] = 'name = :name'; $params[':name'] = clean_pack_name($body['name']); }
$st = db()->prepare('UPDATE homebrew_packs SET ' . implode(', ', $fields) . ' WHERE id = :id AND user_id = :uid');
$st->execute($params);
json_out(['ok' => true]);
