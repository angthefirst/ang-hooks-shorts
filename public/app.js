const form = document.getElementById('shorts-form');
const linksInput = document.getElementById('links');
const resultsEl = document.getElementById('results');
const actionsEl = document.getElementById('actions');
const copyAllBtn = document.getElementById('copy-all-btn');
const submitBtn = document.getElementById('submit-btn');

let latestResults = [];

function parseLinks(rawValue) {
  return rawValue
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
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
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

async function fetchWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
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

function parseTracksXml(xml) {
  const trackRegex = /<track\s+([^>]+?)\s*\/?>(?:<\/track>)?/g;
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
  const listUrl = `https://video.google.com/timedtext?type=list&v=${videoId}`;
  const listXml = await fetchViaProxy(listUrl);
  const tracks = parseTracksXml(listXml);

  if (!Array.isArray(tracks) || tracks.length === 0) {
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

  if (preferredTrack.name) {
    params.set('name', preferredTrack.name);
  }

  const transcriptUrl = `https://video.google.com/timedtext?${params.toString()}`;
  const transcriptXml = await fetchViaProxy(transcriptUrl);
  const transcriptText = parseTranscriptXml(transcriptXml);

  if (!transcriptText) {
    throw new Error('Legenda disponível, mas vazia para este vídeo.');
  }

  return transcriptText;
}

async function getTranscriptFromWatchHtml(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const watchHtml = await fetchViaProxy(watchUrl);

  const playerResponseMatch = watchHtml.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\});/);
  const captionTracksMatch = watchHtml.match(/"captionTracks":(\[[\s\S]*?\])/);

  let captionTracks = null;

  if (playerResponseMatch) {
    try {
      const playerResponse = JSON.parse(playerResponseMatch[1]);
      captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || null;
    } catch {
      captionTracks = null;
    }
  }

  if (!captionTracks && captionTracksMatch) {
    try {
      captionTracks = JSON.parse(captionTracksMatch[1]);
    } catch {
      captionTracks = null;
    }
  }

  if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
    throw new Error('Não foi possível localizar captionTracks no HTML do vídeo.');
  }

  const preferredTrack =
    captionTracks.find((track) => track.languageCode === 'pt-BR') ||
    captionTracks.find((track) => track.languageCode === 'pt') ||
    captionTracks[0];

  if (!preferredTrack?.baseUrl) {
    throw new Error('A trilha encontrada não possui baseUrl.');
  }

  const transcriptXml = await fetchViaProxy(preferredTrack.baseUrl);
  const transcriptText = parseTranscriptXml(transcriptXml);

  if (!transcriptText) {
    throw new Error('captionTrack encontrada, porém sem texto extraível.');
  }

  return transcriptText;
}

async function getTranscriptFromYoutube(videoId) {
  const errors = [];

  try {
    return await getTranscriptFromTimedtext(videoId);
  } catch (error) {
    errors.push(`timedtext: ${error.message}`);
  }

  try {
    return await getTranscriptFromWatchHtml(videoId);
  } catch (error) {
    errors.push(`watch-html: ${error.message}`);
  }

  throw new Error(errors.join(' | '));
}

async function processLink(link) {
  const videoId = extractVideoId(link);

  if (!videoId) {
    return {
      link,
      ok: false,
      error: 'Link inválido ou ID de vídeo não encontrado.'
    };
  }

  const screenshotUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  try {
    const transcriptText = await getTranscriptFromYoutube(videoId);
    const sentences = splitSentences(transcriptText);

    const firstThreeSentences = (sentences.length >= 3 ? sentences : transcriptText.split(','))
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, 3);

    if (firstThreeSentences.length === 0) {
      return {
        link,
        ok: false,
        screenshotUrl,
        error: 'Não foi possível extrair frases do vídeo.'
      };
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
      card.innerHTML = `
        <p class="meta">${item.link}</p>
        <p class="error">${item.error}</p>
      `;
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

  if (links.length === 0) return;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Processando...';
  resultsEl.innerHTML = '<p>Processando links, aguarde...</p>';

  const results = await Promise.all(links.map((link) => processLink(link)));
  renderResults(results);

  submitBtn.disabled = false;
  submitBtn.textContent = 'Processar links';
});
