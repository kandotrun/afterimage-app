import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnvironment } from "./app";

type DailyWeatherRow = {
  readonly local_date: string;
  readonly symbol_name: string;
  readonly temperature_celsius: number;
  readonly high_temperature_celsius: number;
  readonly low_temperature_celsius: number;
  readonly recorded_at: string;
  readonly attribution_legal_url: string;
  readonly attribution_light_url: string;
  readonly attribution_dark_url: string;
};

const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
});

const httpsUrlSchema = z.string().url().max(2_048).refine(
  (value) => URL.canParse(value) && new URL(value).protocol === "https:",
);

const dailyWeatherSchema = z.object({
  symbolName: z.string().regex(/^[a-z0-9.-]{1,64}$/),
  temperatureCelsius: z.number().finite().min(-100).max(100),
  highTemperatureCelsius: z.number().finite().min(-100).max(100),
  lowTemperatureCelsius: z.number().finite().min(-100).max(100),
  recordedAt: z.string().datetime({ offset: true }),
  attributionLegalUrl: httpsUrlSchema,
  attributionLightUrl: httpsUrlSchema,
  attributionDarkUrl: httpsUrlSchema,
}).refine(
  (value) => value.lowTemperatureCelsius <= value.highTemperatureCelsius,
  { path: ["highTemperatureCelsius"] },
);

const dailyWeatherQuerySchema = z.object({
  from: localDateSchema,
  to: localDateSchema,
}).refine((value) => {
  const from = Date.parse(`${value.from}T00:00:00.000Z`);
  const to = Date.parse(`${value.to}T00:00:00.000Z`);
  return from <= to && to - from <= 366 * 24 * 60 * 60 * 1_000;
});

function weatherJson(row: DailyWeatherRow) {
  return {
    localDate: row.local_date,
    symbolName: row.symbol_name,
    temperatureCelsius: row.temperature_celsius,
    highTemperatureCelsius: row.high_temperature_celsius,
    lowTemperatureCelsius: row.low_temperature_celsius,
    recordedAt: row.recorded_at,
    attributionLegalUrl: row.attribution_legal_url,
    attributionLightUrl: row.attribution_light_url,
    attributionDarkUrl: row.attribution_dark_url,
  };
}

async function parseJson(context: Context<AppEnvironment>): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    return undefined;
  }
}

export function registerDailyWeatherRoutes(
  api: Hono<AppEnvironment>,
  now: () => Date,
): void {
  api.put("/weather/days/:date", async (context) => {
    const localDate = localDateSchema.safeParse(context.req.param("date"));
    const weather = dailyWeatherSchema.safeParse(await parseJson(context));
    if (!localDate.success || !weather.success) {
      return context.json({
        error: {
          code: "invalid_daily_weather",
          message: "Daily weather is invalid.",
        },
      }, 400);
    }

    const auth = context.get("auth");
    const updatedAt = now().toISOString();
    await context.env.DB.prepare(
      `INSERT INTO daily_weather (
        user_id, local_date, symbol_name, temperature_celsius,
        high_temperature_celsius, low_temperature_celsius, recorded_at,
        attribution_legal_url, attribution_light_url, attribution_dark_url, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, local_date) DO UPDATE SET
        symbol_name = excluded.symbol_name,
        temperature_celsius = excluded.temperature_celsius,
        high_temperature_celsius = excluded.high_temperature_celsius,
        low_temperature_celsius = excluded.low_temperature_celsius,
        recorded_at = excluded.recorded_at,
        attribution_legal_url = excluded.attribution_legal_url,
        attribution_light_url = excluded.attribution_light_url,
        attribution_dark_url = excluded.attribution_dark_url,
        updated_at = excluded.updated_at`,
    ).bind(
      auth.userId,
      localDate.data,
      weather.data.symbolName,
      weather.data.temperatureCelsius,
      weather.data.highTemperatureCelsius,
      weather.data.lowTemperatureCelsius,
      new Date(weather.data.recordedAt).toISOString(),
      weather.data.attributionLegalUrl,
      weather.data.attributionLightUrl,
      weather.data.attributionDarkUrl,
      updatedAt,
    ).run();

    return context.json({
      item: {
        localDate: localDate.data,
        ...weather.data,
        recordedAt: new Date(weather.data.recordedAt).toISOString(),
      },
    });
  });

  api.get("/weather/days", async (context) => {
    const range = dailyWeatherQuerySchema.safeParse({
      from: context.req.query("from"),
      to: context.req.query("to"),
    });
    if (!range.success) {
      return context.json({
        error: {
          code: "invalid_daily_weather_range",
          message: "Daily weather range is invalid.",
        },
      }, 400);
    }

    const rows = await context.env.DB.prepare(
      `SELECT local_date, symbol_name, temperature_celsius,
              high_temperature_celsius, low_temperature_celsius, recorded_at,
              attribution_legal_url, attribution_light_url, attribution_dark_url
         FROM daily_weather
        WHERE user_id = ? AND local_date BETWEEN ? AND ?
        ORDER BY local_date DESC`,
    ).bind(
      context.get("auth").userId,
      range.data.from,
      range.data.to,
    ).all<DailyWeatherRow>();
    return context.json({ items: rows.results.map(weatherJson) });
  });
}
