"use server";

import { Pool } from "pg";
import { Config, Result, configSchema, explanationsSchema } from "@/lib/types";
import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";

// Create a connection pool
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
});

// Function to get database schema information
export const getDatabaseSchema = async () => {
  "use server";
  try {
    const client = await pool.connect();
    try {
      // Query to get all tables in the current schema
      const tablesQuery = `
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
        ORDER BY table_name;
      `;

      const tablesResult = await client.query(tablesQuery);
      const tables = tablesResult.rows.map((row) => row.table_name);

      // Get schema information for each table
      const schemaInfo = await Promise.all(
        tables.map(async (tableName) => {
          const columnsQuery = `
            SELECT 
              column_name, 
              data_type, 
              is_nullable,
              column_default
            FROM information_schema.columns
            WHERE table_schema = 'public' 
            AND table_name = $1
            ORDER BY ordinal_position;
          `;

          const columnsResult = await client.query(columnsQuery, [tableName]);

          // Format the schema information
          const columns = columnsResult.rows.map((row) => {
            const nullable = row.is_nullable === "YES" ? "NULL" : "NOT NULL";
            const defaultValue = row.column_default
              ? `DEFAULT ${row.column_default}`
              : "";
            return `${row.column_name} ${row.data_type} ${nullable} ${defaultValue}`.trim();
          });

          return {
            tableName,
            columns,
          };
        })
      );

      return schemaInfo;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("Error fetching database schema:", e);
    throw new Error("Failed to fetch database schema");
  }
};

// Modified generateQuery function to use dynamic schema
export const generateQuery = async (input: string) => {
  "use server";
  try {
    // Get the database schema
    const schemaInfo = await getDatabaseSchema();
    console.log(schemaInfo.slice(0, 2000));
    // Format the schema information for the system prompt
    const schemaDescription = schemaInfo
      .map((table) => {
        return `${table.tableName} (
        ${table.columns.join(",\n        ")}
      )`;
      })
      .join("\n\n");

    const result = await generateObject({
      model: openai("gpt-4o"),
      system: `You are a SQL (postgres) and data visualization expert. Your job is to help the user write a SQL query to retrieve the data they need. The database schema is as follows:

      ${schemaDescription}

      Only retrieval queries are allowed.

      For things like industry, company names and other string fields, use the ILIKE operator and convert both the search term and the field to lowercase using LOWER() function. For example: LOWER(industry) ILIKE LOWER('%search_term%').

      Note: If a field is a comma-separated list, trim whitespace to ensure you're grouping properly. Note, some fields may be null or have only one value.
      When answering questions about a specific field, ensure you are selecting the identifying column.

      IMPORTANT: Always use double quotes around table names in your SQL queries to handle case sensitivity correctly. For example: SELECT * FROM "Policyholder" instead of SELECT * FROM Policyholder.

      EVERY QUERY SHOULD RETURN QUANTITATIVE DATA THAT CAN BE PLOTTED ON A CHART! There should always be at least two columns. If the user asks for a single column, return the column and the count of the column. If the user asks for a rate, return the rate as a decimal. For example, 0.1 would be 10%.
      `,
      prompt: `Generate the query necessary to retrieve the data the user wants: ${input}`,
      schema: z.object({
        query: z.string(),
      }),
    });
    return result.object.query;
  } catch (e) {
    console.error(e);
    throw new Error("Failed to generate query");
  }
};

export const runGenerateSQLQuery = async (query: string) => {
  "use server";
  // Check if the query is a SELECT statement
  console.log("query", query);
  const normalizedQuery = query.trim().toLowerCase();
  console.log("normalizedQuery", normalizedQuery);

  // More robust check for SELECT queries
  // Check if the query starts with 'select' followed by any characters
  const isSelectQuery = /^\s*select\b/i.test(query);

  // Check for forbidden operations with detailed logging
  // Use word boundaries to ensure we're matching whole words, not substrings
  const forbiddenOperations = [
    "drop",
    "delete",
    "insert",
    "update",
    "alter",
    "truncate",
    "create",
    "grant",
    "revoke",
  ];

  // Create regex patterns with word boundaries for each forbidden operation
  const forbiddenPatterns = forbiddenOperations.map(
    (op) => new RegExp(`\\b${op}\\b`, "i")
  );

  // Check if any of the patterns match the query
  const detectedOperations = forbiddenOperations.filter((op, index) =>
    forbiddenPatterns[index].test(query)
  );

  console.log("Detected forbidden operations:", detectedOperations);

  const hasForbiddenOperation = detectedOperations.length > 0;

  console.log(
    "isSelectQuery",
    isSelectQuery,
    "hasForbiddenOperation",
    hasForbiddenOperation
  );

  if (!isSelectQuery || hasForbiddenOperation) {
    throw new Error("Only SELECT queries are allowed");
  }

  let data: any;
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(query);
      data = result;
    } finally {
      client.release();
    }
  } catch (e: any) {
    if (e.message.includes('relation "policyholders" does not exist')) {
      console.log(
        "Table does not exist, creating and seeding it with dummy data now..."
      );
      // throw error
      throw Error("Table does not exist");
    } else {
      throw e;
    }
  }

  return data.rows as Result[];
};

// Modified explainQuery function to use dynamic schema
export const explainQuery = async (input: string, sqlQuery: string) => {
  "use server";
  try {
    // Get the database schema
    const schemaInfo = await getDatabaseSchema();

    // Format the schema information for the system prompt
    const schemaDescription = schemaInfo
      .map((table) => {
        return `${table.tableName} (
        ${table.columns.join(",\n        ")}
      )`;
      })
      .join("\n\n");

    const result = await generateObject({
      model: openai("gpt-4o"),
      schema: z.object({
        explanations: explanationsSchema,
      }),
      system: `You are a SQL (postgres) expert. Your job is to explain to the user write a SQL query you wrote to retrieve the data they asked for. The database schema is as follows:
      
      ${schemaDescription}

      When you explain you must take a section of the query, and then explain it. Each "section" should be unique. So in a query like: "SELECT * FROM \"users\" limit 20", the sections could be "SELECT *", "FROM \"users\"", "LIMIT 20".
      If a section doesnt have any explanation, include it, but leave the explanation empty.
      
      IMPORTANT: Note that table names in the queries are properly quoted with double quotes to handle case sensitivity correctly.
      `,
      prompt: `Explain the SQL query you generated to retrieve the data the user wanted. Assume the user is not an expert in SQL. Break down the query into steps. Be concise.

      User Query:
      ${input}

      Generated SQL Query:
      ${sqlQuery}`,
    });
    return result.object;
  } catch (e) {
    console.error(e);
    throw new Error("Failed to generate query");
  }
};

export const generateChartConfig = async (
  results: Result[],
  userQuery: string
) => {
  "use server";
  const system = `You are a data visualization expert. `;

  try {
    const { object: config } = await generateObject({
      model: openai("gpt-4o"),
      system,
      prompt: `Given the following data from a SQL query result, generate the chart config that best visualises the data and answers the users query.
      For multiple groups use multi-lines.

      Here is an example complete config:
      export const chartConfig = {
        type: "pie",
        xKey: "month",
        yKeys: ["sales", "profit", "expenses"],
        colors: {
          sales: "#4CAF50",    // Green for sales
          profit: "#2196F3",   // Blue for profit
          expenses: "#F44336"  // Red for expenses
        },
        legend: true
      }

      User Query:
      ${userQuery}

      Data:
      ${JSON.stringify(results, null, 2)}`,
      schema: configSchema,
    });

    const colors: Record<string, string> = {};
    config.yKeys.forEach((key, index) => {
      colors[key] = `hsl(var(--chart-${index + 1}))`;
    });

    const updatedConfig: Config = { ...config, colors };
    return { config: updatedConfig };
  } catch (e) {
    // @ts-expect-errore
    console.error(e.message);
    throw new Error("Failed to generate chart suggestion");
  }
};
