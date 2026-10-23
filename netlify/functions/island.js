// Netlify Function: everything a home weather station can't measure.
// Forecast, sea state, air quality, dust and sun times for Qala, Gozo.
// Source: Open-Meteo (free, no API key). Sun times are computed locally.

const LAT = 36.0386, LON = 14.3175;      // Qala
const SEA_LAT = 36.08, SEA_LON = 14.40;  // open water off Qala (marine model needs a sea cell)
const TZ = 'Europe/Malta';

const json = (body) => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  body: JSON.stringify(body),
});

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  return res.json();
}

// ---------- sun maths (SunCalc algorithm) ----------
function sunTimes(date, lat, lng) {
  const dayMs = 864e5, J1970 = 2440588, J2000 = 2451545, rad = Math.PI / 180, e = rad * 23.4397, J0 = 0.0009;
  const toDays = (d) => d.valueOf() / dayMs - 0.5 + J1970 - J2000;
  const fromJ = (j) => new Date((j + 0.5 - J1970) * dayMs);
  const lw = rad * -lng, phi = rad * lat, d = toDays(date);
  const n = Math.round(d - J0 - lw / (2 * Math.PI));
  const ds = J0 + (0 + lw) / (2 * Math.PI) + n;
  const M = rad * (357.5291 + 0.98560028 * ds);
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + rad * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const transit = (a) => J2000 + a + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const noonJ = transit(ds);
  const setJ = (h) => {
    const w = Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
    return transit(J0 + (w + lw) / (2 * Math.PI) + n);
  };
  const sunsetJ = setJ(-0.833 * rad), dusk = setJ(-6 * rad);
  return {
    dawn: fromJ(noonJ - (dusk - noonJ)),
    sunrise: fromJ(noonJ - (sunsetJ - noonJ)),
    noon: fromJ(noonJ),
    sunset: fromJ(sunsetJ),
    daylightMin: Math.round((sunsetJ - (noonJ - (sunsetJ - noonJ))) * 1440),
  };
}
const hhmm = (d) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(d);

exports.handler = async () => {
  const errors = [];
  const q = (o) => new URLSearchParams({ timezone: TZ, ...o }).toString();

  const forecastUrl = 'https://api.open-meteo.com/v1/forecast?' + q({
    latitude: LAT, longitude: LON, forecast_days: 7,
    current: 'weather_code,is_day,cloud_cover,visibility,wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,pressure_msl',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,uv_index_max',
    wind_speed_unit: 'kmh',
  });
  const marineUrl = 'https://marine-api.open-meteo.com/v1/marine?' + q({
    latitude: SEA_LAT, longitude: SEA_LON,
    current: 'wave_height,wave_period,wave_direction,sea_surface_temperature',
  });
  const airUrl = 'https://air-quality-api.open-meteo.com/v1/air-quality?' + q({
    latitude: LAT, longitude: LON, current: 'european_aqi,dust,pm10',
  });

  const [f, mar, air] = await Promise.allSettled([get(forecastUrl), get(marineUrl), get(airUrl)]);
  const val = (r, name) => {
    if (r.status === 'fulfilled') return r.value;
    errors.push(`${name}: ${r.reason.message}`);
    return null;
  };
  const fc = val(f, 'forecast'), ma = val(mar, 'marine'), ai = val(air, 'air');

  // Today's date in Malta -> noon UTC of that date for the sun maths
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const s = sunTimes(new Date(today + 'T12:00:00Z'), LAT, LON);

  let daily = [];
  if (fc && fc.daily) {
    const d = fc.daily;
    daily = d.time.map((date, i) => ({
      date,
      code: d.weather_code[i],
      hi: d.temperature_2m_max[i],
      lo: d.temperature_2m_min[i],
      rain: d.precipitation_sum[i],
      rain_prob: d.precipitation_probability_max[i],
      wind_max: d.wind_speed_10m_max[i],
      gust_max: d.wind_gusts_10m_max[i],
      wind_dir: d.wind_direction_10m_dominant[i],
      uv_max: d.uv_index_max[i],
    }));
  }

  return json({
    success: errors.length < 3,
    errors,
    current: fc ? fc.current : null,
    daily,
    marine: ma ? ma.current : null,
    air: ai ? ai.current : null,
    sun: {
      dawn: hhmm(s.dawn), sunrise: hhmm(s.sunrise), noon: hhmm(s.noon), sunset: hhmm(s.sunset),
      daylight: `${Math.floor(s.daylightMin / 60)}h ${s.daylightMin % 60}m`,
    },
  });
};
