require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const mysql   = require('mysql2/promise');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = mysql.createPool({
  host               : process.env.DB_HOST     || 'localhost',
  port               : parseInt(process.env.DB_PORT || '3306', 10),
  user               : process.env.DB_USER     || 'root',
  password           : process.env.DB_PASSWORD || '',
  database           : process.env.DB_NAME     || 'kpop_db',
  waitForConnections : true,
  connectionLimit    : 10,
  queueLimit         : 0,
  timezone           : '+09:00',
});

(async () => {
  try {
    const conn = await pool.getConnection();
    console.log('✅  MySQL 연결 성공:', process.env.DB_NAME || 'kpop_db');
    conn.release();
  } catch (err) {
    console.error('❌  MySQL 연결 실패:', err.message);
    process.exit(1);
  }
})();

const VALID_ERAS   = new Set(['1970', '1980', '1990', '2000', 'all']);
const VALID_GENRES = new Set(['ballad', 'dance', 'hiphop', 'rnb', 'indie', 'rock', 'trot', 'all']);

function sanitize(value, validSet) {
  if (!value || !validSet.has(value)) return 'all';
  return value;
}

function buildRecommendQuery(year, genre) {
  const conditions = [];
  const params     = [];
  if (year  !== 'all') { conditions.push('year_era = ?');   params.push(year);  }
  if (genre !== 'all') { conditions.push('genre_code = ?'); params.push(genre); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT id, title, artist, year_era, genre_code, genre_ko,
           story_text,
           record_metric_title1, record_metric_value1,
           record_metric_title2, record_metric_value2,
           likes
    FROM music_archive
    ${where}
    ORDER BY RAND()
    LIMIT 5
  `;
  return { sql, params };
}

// ── 캐시 방지 ──────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ============================================================
//  GET /api/recommend
// ============================================================
app.get('/api/recommend', async (req, res) => {
  const year  = sanitize(req.query.year,  VALID_ERAS);
  const genre = sanitize(req.query.genre, VALID_GENRES);
  const { sql, params } = buildRecommendQuery(year, genre);
  try {
    const [rows] = await pool.execute(sql, params);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: '조건에 맞는 곡이 없습니다.', data: [] });
    }
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    console.error('🔴  /api/recommend 오류:', err.message);
    return res.status(500).json({ success: false, message: '서버 오류', data: [] });
  }
});

// ============================================================
//  POST /api/like/:id  — 좋아요 토글 (추가/취소)
//  Body: { username: string }  (비로그인 시 username 없으면 익명 처리)
// ============================================================
app.post('/api/like/:id', async (req, res) => {
  const songId   = parseInt(req.params.id, 10);
  const username = req.body.username || null;

  if (isNaN(songId) || songId < 1) {
    return res.status(400).json({ success: false, message: '유효하지 않은 곡 ID입니다.' });
  }

  try {
    // ── 로그인 유저: user_likes 테이블로 토글 관리 ──────────────
    if (username) {
      const [[existing]] = await pool.execute(
        'SELECT id FROM user_likes WHERE username = ? AND song_id = ?',
        [username, songId]
      );

      if (existing) {
        // 이미 좋아요 → 취소 (likes -1, user_likes 삭제)
        await pool.execute('DELETE FROM user_likes WHERE username = ? AND song_id = ?', [username, songId]);
        await pool.execute('UPDATE music_archive SET likes = GREATEST(likes - 1, 0) WHERE id = ?', [songId]);
        const [[row]] = await pool.execute('SELECT likes FROM music_archive WHERE id = ?', [songId]);
        return res.status(200).json({ success: true, liked: false, likes: row.likes });
      } else {
        // 좋아요 추가 (likes +1, user_likes 삽입)
        await pool.execute('INSERT INTO user_likes (username, song_id) VALUES (?, ?)', [username, songId]);
        await pool.execute('UPDATE music_archive SET likes = likes + 1 WHERE id = ?', [songId]);
        const [[row]] = await pool.execute('SELECT likes FROM music_archive WHERE id = ?', [songId]);
        return res.status(200).json({ success: true, liked: true, likes: row.likes });
      }
    }

    // ── 비로그인 유저: 기존 방식 (likes +1만, 취소 불가) ─────────
    const [result] = await pool.execute(
      'UPDATE music_archive SET likes = likes + 1 WHERE id = ?', [songId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: '곡을 찾을 수 없습니다.' });
    }
    const [[row]] = await pool.execute('SELECT likes FROM music_archive WHERE id = ?', [songId]);
    return res.status(200).json({ success: true, liked: true, likes: row.likes });

  } catch (err) {
    console.error('🔴  /api/like 오류:', err.message);
    return res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// ============================================================
//  GET /api/chart/top5  — 좋아요 TOP 5
// ============================================================
app.get('/api/chart/top5', async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT id, title, artist, genre_ko, genre_code, year_era, likes
      FROM music_archive
      ORDER BY likes DESC, id ASC
      LIMIT 5
    `);
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    console.error('🔴  /api/chart/top5 오류:', err.message);
    return res.status(500).json({ success: false, message: '서버 오류', data: [] });
  }
});

// ============================================================
//  GET /api/mypage?username=xxx  — 내가 좋아요한 곡 목록
// ============================================================
app.get('/api/mypage', async (req, res) => {
  const { username } = req.query;
  if (!username) {
    return res.status(400).json({ success: false, message: '로그인이 필요합니다.', data: [] });
  }
  try {
    const [rows] = await pool.execute(`
      SELECT m.id, m.title, m.artist, m.year_era, m.genre_code, m.genre_ko, m.likes,
             ul.created_at AS liked_at
      FROM user_likes ul
      JOIN music_archive m ON ul.song_id = m.id
      WHERE ul.username = ?
      ORDER BY ul.created_at DESC
    `, [username]);
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    console.error('🔴  /api/mypage 오류:', err.message);
    return res.status(500).json({ success: false, message: '서버 오류', data: [] });
  }
});

// ============================================================
//  POST /api/register
// ============================================================
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: '아이디와 비밀번호를 입력해주세요.' });
  }
  if (username.length < 2 || username.length > 20) {
    return res.status(400).json({ success: false, message: '아이디는 2~20자로 입력해주세요.' });
  }
  if (password.length < 4) {
    return res.status(400).json({ success: false, message: '비밀번호는 4자 이상으로 입력해주세요.' });
  }
  try {
    const [[existing]] = await pool.execute('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) {
      return res.status(409).json({ success: false, message: '이미 사용 중인 아이디입니다.' });
    }
    await pool.execute('INSERT INTO users (username, password) VALUES (?, ?)', [username, password]);
    return res.status(201).json({ success: true, message: '회원가입이 완료됐습니다!' });
  } catch (err) {
    console.error('🔴  /api/register 오류:', err.message);
    return res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// ============================================================
//  POST /api/login
// ============================================================
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: '아이디와 비밀번호를 입력해주세요.' });
  }
  try {
    const [[user]] = await pool.execute(
      'SELECT id, username, password FROM users WHERE username = ?', [username]
    );
    if (!user || user.password !== password) {
      return res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
    return res.status(200).json({
      success  : true,
      message  : `${user.username}님, 환영합니다!`,
      username : user.username,
    });
  } catch (err) {
    console.error('🔴  /api/login 오류:', err.message);
    return res.status(500).json({ success: false, message: '서버 오류' });
  }
});

app.use((err, req, res, _next) => {
  console.error('💥  Unhandled Error:', err);
  res.status(500).json({ success: false, message: '예기치 않은 오류' });
});

app.listen(PORT, () => {
  console.log(`🎵  가요연대기 서버 실행 중 → http://localhost:${PORT}`);
  console.log(`   DB: ${process.env.DB_HOST}:${process.env.DB_PORT} / ${process.env.DB_NAME}`);
});

module.exports = app;
