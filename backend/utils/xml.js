/**
 * EC9 XML 工具（微信支付 V2 报文解析/构建，零依赖）
 * 微信 V2 报文为扁平 <xml><k>v</k>...</xml> 结构，CDATA 段先提取后还原，
 * 避免值内含 </xxx> 破坏匹配。
 */
const CDATA_MARK = '\u0000';

/**
 * 微信 XML 报文 → 普通对象
 * @param {string} xml
 * @returns {Record<string,string>}
 */
function parse(xml) {
  const store = [];
  const maskedFull = String(xml).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => {
    store.push(c);
    return CDATA_MARK + (store.length - 1) + CDATA_MARK;
  });

  // 剥掉最外层 <xml> 壳，避免正则把整包当一个节点
  const shell = /^\s*<xml>([\s\S]*)<\/xml>\s*$/.exec(maskedFull);
  const masked = shell ? shell[1] : maskedFull;

  const out = {};
  const re = /<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    let v = m[2].trim();
    const ref = new RegExp('^' + CDATA_MARK + '(\\d+)' + CDATA_MARK + '$').exec(v);
    out[m[1]] = ref ? store[Number(ref[1])] : v;
  }
  return out;
}

/**
 * 普通对象 → 微信 XML 报文（含 <xml> 根节点；含特殊字符自动 CDATA）
 */
function build(obj) {
  let body = '';
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined || obj[k] === null) continue;
    const v = String(obj[k]);
    const safe = /[<>&'"]/.test(v) ? `<![CDATA[${v}]]>` : v;
    body += `<${k}>${safe}</${k}>`;
  }
  return `<xml>${body}</xml>`;
}

module.exports = { parse, build };
