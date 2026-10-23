// Netlify Function: live + historical data from YOUR Weather Underground PWS.
// Needs the Netlify environment variable WU_API_KEY (optional: WU_STATION_ID).

const STATION_ID = process.env.WU_STATION_ID || 'IQALA3';
const MAX_AGE_MIN = 20; // last report older than this => station is OFFLINE
const BASE = 'https://api.weather.com/v2/pws';

const json = (body) => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

async function wu(path, apiKey) {
  const url = `${BASE}/${path}?stationId=${encodeURIComponent(STATION_ID)}&format=json&units=m&numericPrecision=decimal&apiKey=${apiKey}`;
  const res = await fetch(url);
  if (res.status === 204) return { empty: true };
  if (!res.ok) throw new Error(`Weather Underground HTTP ${res.status}`);
  return res.json();
}

exports.handler = async () => {
  const apiKey = process.env.WU_API_KEY;
  if (!apiKey) return json({ success: false, reason: 'WU_API_KEY environment variable is not set on Netlify' });

  const [curR, histR] = await Promise.allSettled([
    wu('observations/current', apiKey),
    wu('observations/hourly/7day', apiKey),
  ]);

  // ---- last 24 hourly points (for the chart + pressure trend) ----
  let history = [];
  let pressureChange3h = null;
  if (histR.status === 'fulfilled' && histR.value.observations) {
    const obs = histR.value.observations
      .filter((o) => o.metric && o.metric.tempAvg != null)
      .sort((a, b) => a.epoch - b.epoch)
      .slice(-24);
    history = obs.map((o) => ({
      t: o.epoch * 1000,
      temp: o.metric.tempAvg,
      hum: o.humidityAvg,
      wind: o.metric.windspeedAvg,
    }));
    const p = obs.map((o) =>
      o.metric.pressureMax != null && o.metric.pressureMin != null
        ? (o.metric.pressureMax + o.metric.pressureMin) / 2
        : null
    );
    const last = p[p.length - 1];
    const prev = p[p.length - 4];
    if (last != null && prev != null) pressureChange3h = last - prev;
  }

  // ---- current observation ----
  if (curR.status === 'rejected') {
    return json({ success: false, reason: curR.reason.message, history });
  }
  const o = curR.value.observations && curR.value.observations[0];
  if (!o) return json({ success: false, reason: 'Station has no current data (offline)', history });

  const m = o.metric || {};
  const ageMin = (Date.now() - new Date(o.obsTimeUtc).getTime()) / 60000;
  const online = ageMin <= MAX_AGE_MIN;

  let feels = m.temp;
  if (m.temp >= 27 && m.heatIndex != null) feels = m.heatIndex;
  else if (m.temp <= 16 && m.windChill != null) feels = m.windChill;

  return json({
    success: online,
    reason: online ? 'ok' : `Last report was ${Math.round(ageMin)} min ago`,
    lastUpdated: o.obsTimeUtc,
    ageMinutes: Math.round(ageMin),
    history,
    readings: {
      temperature: m.temp,
      feels_like: feels,
      dew_point: m.dewpt,
      humidity: o.humidity,
      wind_speed: m.windSpeed,
      wind_gust: m.windGust,
      wind_direction: o.winddir,
      pressure_msl: m.pressure,
      pressure_change_3h: pressureChange3h,
      precipitation: m.precipTotal,
      precip_rate: m.precipRate,
      uv_index: o.uv,
      solar_radiation: o.solarRadiation,
    },
  });
};
