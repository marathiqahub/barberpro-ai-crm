'use strict';
function csvCell(value){let s=String(value??'');if(/^[\\s]*[=+@-]/.test(s))s="'"+s;return /[",\\r\\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}
function toCsv(rows,headers){return [headers.map(csvCell).join(','),...rows.map(row=>headers.map(h=>csvCell(row[h])).join(','))].join('\r\n')+'\r\n';}
function parseCsv(text){
 const rows=[];let row=[],cell='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(c==='"')quoted=false;else cell+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(cell);cell='';}else if(c==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=c;}
 if(quoted)throw new Error('CSV contains an unterminated quoted field.');
 if(cell.length||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}
 if(!rows.length)return [];
 const headers=rows.shift().map(x=>String(x).trim());
 return rows.filter(r=>r.some(v=>String(v??'').trim())).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]??''])));
}
module.exports={csvCell,toCsv,parseCsv};
