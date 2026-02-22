const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

function extractVideoId(url) {
  if (!url || typeof url !== 'string') return null;
  const cleanUrl = url.trim();
  if (!cleanUrl) return null;

  const patterns = [
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/
  ];

  for (const pattern of patterns) {
    const match = cleanUrl.match(pattern);
    if (match && match[1]) return match[1];
  }

  try {
    const parsed = new URL(cleanUrl);
    const id = parsed.searchParams.get('v');
    if (id && id.length === 11) return id;
  } catch {
    return null;
  }

  return null;
}

function splitSentences(text) {
  if (!text) return [];
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function getTranscriptFromYoutube(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const watchResponse = await fetch(watchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0'
    }
  });

  if (!watchResponse.ok) {
    throw new Error('Não foi possível carregar página do vídeo.');
  }

  const watchHtml = await watchResponse.text();
  const match = watchHtml.match(/"captionTracks":(\[[^\]]+\])/);
  if (!match) {
    throw new Error('Vídeo sem legendas disponíveis.');
  }

  let captionTracks;
  try {
    captionTracks = JSON.parse(match[1]);
  } catch {
    throw new Error('Falha ao interpretar trilhas de legenda.');
  }

  if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
    throw new Error('Nenhuma trilha de legenda encontrada.');
  }

  const preferredTrack =
    captionTracks.find((track) => track.languageCode === 'pt') ||
    captionTracks.find((track) => track.languageCode === 'pt-BR') ||
    captionTracks[0];

  if (!preferredTrack || !preferredTrack.baseUrl) {
    throw new Error('URL de legenda ausente.');
  }

  const transcriptResponse = await fetch(preferredTrack.baseUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0'
    }
  });

  if (!transcriptResponse.ok) {
    throw new Error('Falha ao baixar legenda.');
  }

  const xml = await transcriptResponse.text();
  const textMatches = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)];
  const text = textMatches
    .map((matchItem) => decodeHtmlEntities(matchItem[1].replace(/\n/g, ' ').trim()))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

async function processLink(link) {
  const videoId = extractVideoId(link);
  if (!videoId) {
    return { link, ok: false, error: 'Link inválido ou ID de vídeo não encontrado.' };
  }

  const screenshotUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  try {
    const transcriptText = await getTranscriptFromYoutube(videoId);
    const sentences = splitSentences(transcriptText);
    const firstThreeSentences = (sentences.length >= 3 ? sentences : transcriptText.split(',')).map((s) => s.trim()).filter(Boolean).slice(0,3);

    if (firstThreeSentences.length === 0) {
      return { link, ok: false, screenshotUrl, error: 'Não foi possível extrair frases do vídeo.' };
    }

    return {
      link,
      ok: true,
      videoId,
      screenshotUrl,
      firstThreeSentences
    };
  } catch (error) {
    return {
      link,
      ok: false,
      screenshotUrl,
      error: 'Falha ao buscar legenda/transcrição deste vídeo.'
    };
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function serveStatic(req, res) {
  const reqPath = req.url === '/' ? '/index.html' : req.url;
  const normalized = path.normalize(reqPath).replace(/^\.\.(\/|\\|$)/, '');
  const filePath = path.join(PUBLIC_DIR, normalized);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath);
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8'
    };

    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/shorts/process') {
    let rawBody = '';
    req.on('data', (chunk) => {
      rawBody += chunk;
      if (rawBody.length > 1_000_000) {
        req.destroy();
      }
    });

    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(rawBody || '{}');
      } catch {
        sendJson(res, 400, { error: 'JSON inválido.' });
        return;
      }

      const links = body.links;
      if (!Array.isArray(links) || links.length === 0) {
        sendJson(res, 400, { error: 'Envie uma lista de links válida.' });
        return;
      }

      const results = await Promise.all(links.map((link) => processLink(link)));
      sendJson(res, 200, { results });
    });
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`Servidor ativo em http://localhost:${PORT}`);
});
