import { CSV_TEMPLATE } from "@/lib/csv";

export function GET() {
  return new Response(CSV_TEMPLATE, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="move-beyond-teams-template.csv"',
    },
  });
}
