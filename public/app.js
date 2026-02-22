const form = document.getElementById('shorts-form');
const linksInput = document.getElementById('links');
const resultsEl = document.getElementById('results');
const actionsEl = document.getElementById('actions');
const copyAllBtn = document.getElementById('copy-all-btn');
const submitBtn = document.getElementById('submit-btn');

let latestResults = [];

const INVIDIOUS_INSTANCES = [
  'https://invidious.privacyredirect.com',
  'https://invidious.fdn.fr',
  'https://iv.nboeck.de',
  'https://invidious.projectsegfau.lt',
  'https://yewtu.be'
];

function parseLinks(rawValue) {
  return rawValue.split('\n').map((line) => line.trim()).filter(Boolean);
}

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

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function splitSentences(text) {
  if (!text) return [];
  return text.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
}

function vttToText(vtt) {
  return vtt
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('WEBVTT') && !line.includes('-->') && !/^\d+$/.test(line))
    .join(' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchViaProxy(targetUrl) {
  const encoded = encodeURIComponent(targetUrl);
  const proxyUrls = [
    `https://api.allorigins.win/raw?url=${encoded}`,
    `https://corsproxy.io/?${encoded}`,
    `https://api.codetabs.com/v1/proxy?quest=${encoded}`
  ];

  let lastError = null;
  for (const proxyUrl of proxyUrls) {
    try {
      return await fetchWithTimeout(proxyUrl);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Todos os proxies falharam (${lastError?.message || 'erro desconhecido'}).`);
}

async function getTranscriptFromInvidious(videoId) {
  const errors = [];

  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const listRaw = await fetchWithTimeout(`${instance}/api/v1/captions/${videoId}`);
      const tracks = JSON.parse(listRaw);
      if (!Array.isArray(tracks) || tracks.length === 0) {
        throw new Error('instância sem trilhas para este vídeo');
      }

      const preferred =
        tracks.find((t) => t.language_code === 'pt-BR') ||
        tracks.find((t) => t.language_code === 'pt') ||
        tracks[0];

      const trackUrl = preferred?.url?.startsWith('http')
        ? preferred.url
        : `${instance}${preferred?.url || ''}`;

      if (!trackUrl) {
        throw new Error('trilha sem URL');
      }

      const vtt = await fetchWithTimeout(trackUrl);
      const transcriptText = vttToText(vtt);
      if (!transcriptText) {
        throw new Error('VTT retornou sem texto útil');
      }

      return transcriptText;
    } catch (error) {
      errors.push(`${instance}: ${error.message}`);
    }
  }

  throw new Error(`Invidious indisponível (${errors.slice(0, 2).join(' | ')})`);
}

function parseTracksXml(xml) {
  const trackRegex = /<track\s+([^>]+?)\s*\/?>/g;
  const attrRegex = /(\w+)="([^"]*)"/g;
  const tracks = [];

  for (const match of xml.matchAll(trackRegex)) {
    const attrs = {};
    for (const attrMatch of match[1].matchAll(attrRegex)) {
      attrs[attrMatch[1]] = decodeHtmlEntities(attrMatch[2]);
    }
    tracks.push(attrs);
  }

  return tracks;
}

function parseTranscriptXml(xml) {
  const textMatches = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)];
  return textMatches
    .map((match) => decodeHtmlEntities(match[1].replace(/\n/g, ' ').trim()))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getTranscriptFromTimedtext(videoId) {
  const listXml = await fetchViaProxy(`https://video.google.com/timedtext?type=list&v=${videoId}`);
  const tracks = parseTracksXml(listXml);

  if (!tracks.length) {
    throw new Error('Vídeo sem trilhas de legenda públicas.');
  }

  const preferredTrack =
    tracks.find((track) => track.lang_code === 'pt-BR') ||
    tracks.find((track) => track.lang_code === 'pt') ||
    tracks[0];

  const params = new URLSearchParams({
    v: videoId,
    lang: preferredTrack.lang_code,
    fmt: 'srv3'
  });

  if (preferredTrack.name) params.set('name', preferredTrack.name);

  const transcriptXml = await fetchViaProxy(`https://video.google.com/timedtext?${params.toString()}`);
  const transcriptText = parseTranscriptXml(transcriptXml);

  if (!transcriptText) throw new Error('Legenda disponível, mas sem texto extraível.');
  return transcriptText;
}

async function getTranscriptFromYoutube(videoId) {
  const errors = [];

  try {
    return await getTranscriptFromInvidious(videoId);
  } catch (error) {
    errors.push(`invidious: ${error.message}`);
  }

  try {
    return await getTranscriptFromTimedtext(videoId);
  } catch (error) {
    errors.push(`timedtext: ${error.message}`);
  }

  throw new Error(errors.join(' | '));
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
    const firstThreeSentences = (sentences.length >= 3 ? sentences : transcriptText.split(','))
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, 3);

    if (!firstThreeSentences.length) {
      return { link, ok: false, screenshotUrl, error: 'Não foi possível extrair frases do vídeo.' };
    }

    return { link, ok: true, videoId, screenshotUrl, firstThreeSentences };
  } catch (error) {
    return {
      link,
      ok: false,
      screenshotUrl,
      error: `Falha ao buscar legenda/transcrição. Detalhe: ${error.message}`
    };
  }
}

function formatResult(item) {
  return [
    `Link: ${item.link}`,
    `Print: ${item.screenshotUrl}`,
    'Frases:',
    ...item.firstThreeSentences.map((sentence, index) => `${index + 1}. ${sentence}`)
  ].join('\n');
}

function renderResults(results) {
  latestResults = results;
  resultsEl.innerHTML = '';

  const hasSuccess = results.some((item) => item.ok);
  actionsEl.classList.toggle('hidden', !hasSuccess);

  results.forEach((item) => {
    const card = document.createElement('article');
    card.className = 'card';

    if (!item.ok) {
      card.innerHTML = `<p class="meta">${item.link}</p><p class="error">${item.error}</p>`;
      resultsEl.appendChild(card);
      return;
    }

    const sentencesHtml = item.firstThreeSentences.map((sentence) => `<li>${sentence}</li>`).join('');

    card.innerHTML = `
      <p class="meta">${item.link}</p>
      <img src="${item.screenshotUrl}" alt="Print inicial do vídeo ${item.videoId}" />
      <h3>3 primeiras frases</h3>
      <ol>${sentencesHtml}</ol>
      <button class="copy-btn" type="button">Copiar este bloco</button>
    `;

    const copyBtn = card.querySelector('.copy-btn');
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(formatResult(item));
      copyBtn.textContent = 'Copiado!';
      setTimeout(() => {
        copyBtn.textContent = 'Copiar este bloco';
      }, 1500);
    });

    resultsEl.appendChild(card);
  });
}

copyAllBtn.addEventListener('click', async () => {
  const text = latestResults
    .filter((item) => item.ok)
    .map((item) => formatResult(item))
    .join('\n\n--------------------\n\n');

  await navigator.clipboard.writeText(text);
  copyAllBtn.textContent = 'Tudo copiado!';
  setTimeout(() => {
    copyAllBtn.textContent = 'Copiar tudo';
  }, 1500);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const links = parseLinks(linksInput.value);
  if (!links.length) return;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Processando...';
  resultsEl.innerHTML = '<p>Processando links, aguarde...</p>';

  const results = await Promise.all(links.map((link) => processLink(link)));
  renderResults(results);

  submitBtn.disabled = false;
  submitBtn.textContent = 'Processar links';
});
