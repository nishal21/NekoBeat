// Cloudflare Worker: SoundCloud Proxy
// Proxies SoundCloud API requests from Cloudflare's edge network
// Supports two modes:
//   1. Generic proxy: ?url=<encoded_soundcloud_api_url>
//   2. Stream resolver: ?track_id=<id>&client_id=<cid> — resolves full stream URL
//
// Deploy: npx wrangler deploy
// URL: https://nekobeat-sc-proxy.nishalk.workers.dev

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function scFetch(url) {
  return fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://soundcloud.com/',
      'Origin': 'https://soundcloud.com',
    }
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Mode 1: Generic proxy
    const targetUrl = url.searchParams.get('url');
    if (targetUrl) {
      if (!targetUrl.includes('soundcloud.com') && !targetUrl.includes('sndcdn.com')) {
        return jsonResponse({ error: 'Only SoundCloud URLs allowed' }, 403);
      }
      try {
        const response = await scFetch(targetUrl);
        const body = await response.text();
        return new Response(body, {
          status: response.status,
          headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json', ...CORS_HEADERS }
        });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // Mode 2: Full stream resolver
    const trackId = url.searchParams.get('track_id');
    const clientId = url.searchParams.get('client_id');
    if (trackId && clientId) {
      try {
        return await resolveStream(trackId, clientId);
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    return jsonResponse({ 
      status: 'ok', 
      usage: '?url=<encoded_url> or ?track_id=<id>&client_id=<cid>',
      colo: request.cf?.colo || 'unknown'
    }, 200);
  }
};

async function resolveStream(trackId, clientId) {
  // Step 1: Get track metadata
  const trackUrl = `https://api-v2.soundcloud.com/tracks/${trackId}?client_id=${clientId}`;
  const trackResp = await scFetch(trackUrl);
  if (!trackResp.ok) {
    return jsonResponse({ error: `Track API returned ${trackResp.status}` }, trackResp.status);
  }
  const trackData = await trackResp.json();
  
  const policy = trackData.policy || 'unknown';
  const trackAuth = trackData.track_authorization || '';
  const transcodings = trackData.media?.transcodings || [];
  
  // Try each transcoding to find a non-preview stream
  for (const tc of transcodings) {
    const tcUrl = tc.url;
    const protocol = tc.format?.protocol;
    if (!tcUrl) continue;
    
    // Resolve the transcoding URL
    const streamApiUrl = `${tcUrl}?client_id=${clientId}&track_authorization=${trackAuth}`;
    try {
      const streamResp = await scFetch(streamApiUrl);
      if (streamResp.ok) {
        const streamData = await streamResp.json();
        const streamUrl = streamData.url;
        if (streamUrl && !streamUrl.includes('/preview/') && !streamUrl.includes('preview-media')) {
          return jsonResponse({ 
            url: streamUrl, 
            protocol,
            policy,
            full: true 
          });
        }
      }
    } catch (e) {
      // Try next transcoding
    }
  }
  
  // If all transcodings are previews, return metadata so client knows
  return jsonResponse({ 
    error: 'All streams are previews/snipped',
    policy,
    snipped: true,
    title: trackData.title || '',
    duration: trackData.duration,
    full_duration: trackData.full_duration,
  }, 200);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
}
