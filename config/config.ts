export async function getConfig() {
  return JSON.parse(await Bun.file("./config/providers.json").text());
}
export async function saveConfig(config: any) {
  await Bun.write("./config/providers.json", JSON.stringify(config, null, 2));
}
