import { getDynamicData } from "@/utils/dynamic-data";

export async function GET() {
	const data = await getDynamicData();

	return new Response(JSON.stringify(data), {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}
