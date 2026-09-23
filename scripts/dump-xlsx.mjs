import ExcelJS from "exceljs";

const file = process.argv[2];
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);

console.log(`FILE: ${file}`);
wb.eachSheet((ws) => {
  console.log(`\n===== SHEET: "${ws.name}" (rows=${ws.rowCount}, cols=${ws.columnCount}) =====`);
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      let v = cell.value;
      if (v && typeof v === "object") {
        if (v.result !== undefined) v = `=${v.formula}→${v.result}`;
        else if (v.richText) v = v.richText.map((t) => t.text).join("");
        else if (v.text) v = v.text;
        else v = JSON.stringify(v);
      }
      if (v !== null && v !== undefined && v !== "") cells.push(`${cell.address}:${v}`);
    });
    if (cells.length) console.log(`R${rowNumber}| ${cells.join(" | ")}`);
  });
});
