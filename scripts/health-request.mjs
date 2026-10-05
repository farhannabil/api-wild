export async function healthRequest(url, options = {}, fetchImpl = fetch) {
  const attempts = ['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase()) ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchImpl(url, {...options, redirect: 'manual', signal: AbortSignal.timeout(15000)});
      if (response.status >= 500 && attempt + 1 < attempts) {
        await response.body?.cancel();
        continue;
      }
      return response;
    } catch (error) { if (attempt + 1 === attempts) throw error; }
  }
}

export function requireStatus(response, expected) {
  if (response.status !== expected) {
    throw Object.assign(new Error('Health response status mismatch.'), {code: `HTTP_${response.status}_EXPECTED_${expected}`});
  }
}
