import { Pool } from "pg";
import fs from "fs";
import csv from "csv-parser";
import path from "path";
import "dotenv/config";

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
});

function parseDate(dateString: string): string {
  if (!dateString) {
    console.warn("Empty date string provided, using today's date");
    const today = new Date();
    return today.toISOString().split("T")[0]; // Returns YYYY-MM-DD format
  }

  console.log(`Parsing date: ${dateString}`); // Debug log

  try {
    const parts = dateString.split("/");
    if (parts.length === 3) {
      const day = parts[0].padStart(2, "0");
      const month = parts[1].padStart(2, "0");
      const year = parts[2];

      // Validate the date components
      const date = new Date(`${year}-${month}-${day}`);
      if (isNaN(date.getTime())) {
        console.warn(
          `Invalid date components: ${dateString}, using today's date`
        );
        const today = new Date();
        return today.toISOString().split("T")[0];
      }

      return `${year}-${month}-${day}`;
    }
  } catch (error) {
    console.warn(`Error parsing date: ${dateString}, using today's date`);
  }

  // Default to today's date if parsing fails
  const today = new Date();
  return today.toISOString().split("T")[0];
}

export async function seed() {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS unicorns (
        id SERIAL PRIMARY KEY,
        company VARCHAR(255) NOT NULL UNIQUE,
        valuation DECIMAL(10, 2) NOT NULL,
        date_joined DATE,
        country VARCHAR(255) NOT NULL,
        city VARCHAR(255) NOT NULL,
        industry VARCHAR(255) NOT NULL,
        select_investors TEXT NOT NULL
      );
    `);

    console.log(`Created "unicorns" table`);

    const results: any[] = [];
    const csvFilePath = path.join(process.cwd(), "unicorns_clean.csv");

    await new Promise((resolve, reject) => {
      fs.createReadStream(csvFilePath)
        .pipe(
          csv({
            skipLines: 1, // Skip the header row
            headers: [
              "empty",
              "company",
              "valuation",
              "date_joined",
              "country",
              "city",
              "industry",
              "select_investors",
              "rest",
            ],
          })
        )
        .on("data", (data) => {
          console.log(`Processing row for company: ${data.company}`); // Debug log
          results.push(data);
        })
        .on("end", resolve)
        .on("error", reject);
    });

    console.log(`Read ${results.length} rows from CSV`);

    for (const row of results) {
      if (!row.company || row.company.trim() === "") {
        console.log("Skipping empty row");
        continue;
      }

      console.log(
        `Processing company: ${row.company}, Date: ${row.date_joined}`
      ); // Debug log

      const formattedDate = parseDate(row.date_joined);

      const valuationStr = row.valuation
        ? row.valuation.replace("$", "").replace(",", "")
        : "0";
      const valuation = parseFloat(valuationStr);

      if (isNaN(valuation)) {
        console.log(
          `Skipping row with invalid valuation for company: ${row.company}`
        );
        continue;
      }

      try {
        await client.query(
          `INSERT INTO unicorns (company, valuation, date_joined, country, city, industry, select_investors)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (company) DO NOTHING`,
          [
            row.company,
            valuation,
            formattedDate,
            row.country,
            row.city,
            row.industry,
            row.select_investors,
          ]
        );
        console.log(`Successfully inserted ${row.company}`); // Debug log
      } catch (error) {
        console.error(`Error inserting row for company ${row.company}:`, error);
      }
    }

    console.log(`Seeded unicorns table`);

    return {
      unicorns: results,
    };
  } finally {
    client.release();
  }
}

seed().catch(console.error);
