import type {
  VoiceTool,
  VoiceToolExecution,
  VoiceToolRequest,
  VoiceToolSessionContext,
} from "@/tools/types";
import type { VoiceWeatherWidgetPayload } from "@sarjy/shared-types";

interface GeocodingResult {
  name: string;
  country?: string;
  admin1?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
}

interface OpenMeteoCurrent {
  temperature_2m?: number;
  apparent_temperature?: number;
  relative_humidity_2m?: number;
  precipitation?: number;
  weather_code?: number;
  cloud_cover?: number;
  wind_speed_10m?: number;
  wind_direction_10m?: number;
}

function extractLocationArgument(request: VoiceToolRequest): string | null {
  const value = request.arguments?.location;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

async function waitForCoords(
  session: VoiceToolSessionContext | undefined,
  maxMs: number,
  pollMs: number,
  signal: AbortSignal,
): Promise<{ latitude: number; longitude: number } | null> {
  if (!session) return null;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (signal.aborted) return null;
    const c = session.getClientLocation();
    if (c) return c;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollMs);
    });
  }
  return session.getClientLocation();
}

async function reverseGeocode(
  latitude: number,
  longitude: number,
  signal: AbortSignal,
): Promise<GeocodingResult | null> {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    language: "en",
    format: "json",
  });
  const response = await fetch(
    `https://geocoding-api.open-meteo.com/v1/reverse?${params.toString()}`,
    { signal },
  );
  if (!response.ok) {
    throw new Error(`Reverse geocoding failed with status ${response.status}`);
  }
  const body = await response.json() as { results?: GeocodingResult[] };
  return body.results?.[0] ?? null;
}

async function fetchForecastAtCoords(
  latitude: number,
  longitude: number,
  placeLabel: string,
  signal: AbortSignal,
  originalRequest: VoiceToolRequest,
): Promise<VoiceToolExecution> {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: [
      "temperature_2m",
      "apparent_temperature",
      "relative_humidity_2m",
      "precipitation",
      "weather_code",
      "cloud_cover",
      "wind_speed_10m",
      "wind_direction_10m",
    ].join(","),
    timezone: "auto",
  });

  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, { signal });
  if (!response.ok) {
    throw new Error(`Weather API failed with status ${response.status}`);
  }

  const body = await response.json() as {
    current?: OpenMeteoCurrent;
    current_units?: Record<string, string>;
  };
  const current = body.current ?? {};
  const units = body.current_units ?? {};
  const condition = describeWeatherCode(current.weather_code);
  const wind = describeWind(current.wind_direction_10m);
  const windSummary = `${formatNumber(current.wind_speed_10m)}${units.wind_speed_10m ?? "km/h"} ${wind}`.trim();

  const widget: VoiceWeatherWidgetPayload = {
    placeLabel,
    condition,
    temperatureC: typeof current.temperature_2m === "number" ? current.temperature_2m : null,
    feelsLikeC: typeof current.apparent_temperature === "number" ? current.apparent_temperature : null,
    humidityPct: typeof current.relative_humidity_2m === "number" ? current.relative_humidity_2m : null,
    precipitationMm: typeof current.precipitation === "number" ? current.precipitation : null,
    cloudCoverPct: typeof current.cloud_cover === "number" ? current.cloud_cover : null,
    windSummary,
  };

  return {
    request: originalRequest,
    contextText: [
      `Weather for ${placeLabel}:`,
      `Condition: ${condition}.`,
      `Temperature: ${formatNumber(current.temperature_2m)}${units.temperature_2m ?? "°C"}.`,
      `Feels like: ${formatNumber(current.apparent_temperature)}${units.apparent_temperature ?? "°C"}.`,
      `Humidity: ${formatNumber(current.relative_humidity_2m)}${units.relative_humidity_2m ?? "%"}.`,
      `Cloud cover: ${formatNumber(current.cloud_cover)}${units.cloud_cover ?? "%"}.`,
      `Precipitation: ${formatNumber(current.precipitation)}${units.precipitation ?? "mm"}.`,
      `Wind: ${windSummary}.`,
    ].join("\n"),
    weatherWidget: widget,
  };
}

async function executeWeather(
  request: VoiceToolRequest,
  signal: AbortSignal,
  session?: VoiceToolSessionContext,
): Promise<VoiceToolExecution> {
  const location = extractLocationArgument(request);

  if (location) {
    const place = await geocodeLocation(location, signal);
    if (!place) {
      return {
        request,
        contextText: `Weather tool could not find a matching location for "${location}". Ask the user to clarify the city or region.`,
      };
    }
    const label = [place.name, place.admin1, place.country].filter(Boolean).join(", ");
    return fetchForecastAtCoords(place.latitude, place.longitude, label, signal, request);
  }

  let coords = session?.getClientLocation() ?? null;
  if (!coords && session) {
    session.signalNeedClientLocation();
    coords = await waitForCoords(session, 4500, 120, signal);
  }

  if (!coords) {
    return {
      request,
      contextText:
        "No location name was given and the device has not shared GPS coordinates yet. "
        + "Briefly ask the user to allow location in the browser if they want a local forecast, "
        + "or name a city. Stay concise.",
    };
  }

  let placeLabel = "Your location";
  try {
    const rev = await reverseGeocode(coords.latitude, coords.longitude, signal);
    if (rev) {
      placeLabel = [rev.name, rev.admin1, rev.country].filter(Boolean).join(", ") || placeLabel;
    }
  } catch {
    /* keep generic label */
  }

  return fetchForecastAtCoords(coords.latitude, coords.longitude, placeLabel, signal, request);
}

/**
 * Live Open-Meteo snapshot for system-prompt context when device coordinates are known.
 * Returns null on failure (caller omits weather from the prompt).
 */
export async function fetchWeatherSnapshotForCoordinates(
  latitude: number,
  longitude: number,
  signal: AbortSignal,
): Promise<string | null> {
  const dummyRequest: VoiceToolRequest = {
    name: "weather",
    arguments: { location: null },
  };
  try {
    let placeLabel = "Your location";
    try {
      const rev = await reverseGeocode(latitude, longitude, signal);
      if (rev) {
        placeLabel = [rev.name, rev.admin1, rev.country].filter(Boolean).join(", ") || placeLabel;
      }
    } catch {
      /* keep generic label */
    }
    const exec = await fetchForecastAtCoords(latitude, longitude, placeLabel, signal, dummyRequest);
    return exec.contextText.trim() || null;
  } catch {
    return null;
  }
}

async function geocodeLocation(location: string, signal: AbortSignal): Promise<GeocodingResult | null> {
  const params = new URLSearchParams({
    name: location,
    count: "1",
    language: "en",
    format: "json",
  });
  const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`, { signal });
  if (!response.ok) {
    throw new Error(`Weather geocoding failed with status ${response.status}`);
  }

  const body = await response.json() as { results?: GeocodingResult[] };
  return body.results?.[0] ?? null;
}

function formatNumber(value: number | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "unknown";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function describeWeatherCode(code: number | undefined): string {
  switch (code) {
    case 0: return "clear sky";
    case 1: return "mainly clear";
    case 2: return "partly cloudy";
    case 3: return "overcast";
    case 45:
    case 48: return "fog";
    case 51:
    case 53:
    case 55: return "drizzle";
    case 56:
    case 57: return "freezing drizzle";
    case 61:
    case 63:
    case 65: return "rain";
    case 66:
    case 67: return "freezing rain";
    case 71:
    case 73:
    case 75: return "snow";
    case 77: return "snow grains";
    case 80:
    case 81:
    case 82: return "rain showers";
    case 85:
    case 86: return "snow showers";
    case 95: return "thunderstorm";
    case 96:
    case 99: return "thunderstorm with hail";
    default: return "unknown";
  }
}

function describeWind(degrees: number | undefined): string {
  if (typeof degrees !== "number" || Number.isNaN(degrees)) return "";
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const index = Math.round(degrees / 45) % directions.length;
  return directions[index] ?? "";
}

export const weatherTool: VoiceTool = {
  name: "weather",
  description: "Fetch the current weather conditions for a city, region, or place using a live weather API.",
  parameters: {
    location: {
      type: "string",
      description:
        "City, region, or place name when the user named one. Use null when they did not name a place "
        + "— the server will use device coordinates if available, otherwise it will ask the browser for permission.",
      nullable: true,
    },
  },
  examples: [
    "what's the weather in London",
    "is it raining outside",
    "do I need a coat tomorrow",
    "how hot is it in Tokyo right now",
  ],
  guidance:
    "Call only for current real-world conditions. "
    + "If the system context says coordinates are available and the user did not name a place, call with location null. "
    + "If coordinates are not available yet, follow the system instructions for what to say, then still call with location null so the client can prompt for GPS.",
  execute: executeWeather,
};
