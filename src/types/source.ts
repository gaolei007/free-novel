// 书源解析规则接口定义
export interface RuleSearch {
  url: string;             // 搜索请求地址，{{key}} 为关键词占位，如: "https://example.com/search?key={{key}}"
  method?: 'GET' | 'POST'; // 请求类型
  data?: string;           // POST 表单模板，{{key}} 为关键词占位，如: "s={{key}}"
  bookList: string;        // 小说列表 CSS 选择器，如: ".book-item"
  name: string;            // 书名选择器，如: ".book-title"
  author?: string;         // 作者选择器，如: ".author-name"
  latestChapter?: string;  // 最近章节选择器
  detailUrl: string;       // 详情页链接选择器或属性，如: "a@href"
}

export interface RuleDetail {
  catalogUrl?: string;     // 目录页链接选择器（若详情页即目录页可留空）
  cover?: string;          // 封面图片选择器
  intro?: string;          // 简介选择器
}

export interface RuleCatalog {
  chapterList: string;     // 章节列表 CSS 选择器，如: "#list dd a"
  chapterName: string;     // 章节名选择器或提取逻辑（为空则取元素自身文本）
  chapterUrl: string;      // 章节详情链接选择器，如: "href"
  nextPage?: string;       // 目录分页选择器（select option 或分页链接，取 value/href）
}

export interface RuleContent {
  content: string;         // 正文内容 CSS 选择器，如: "#content"
  filter?: string[];       // 需要移除的标签选择器（广告标签）
  filterText?: string[];   // 需要过滤的文本/正则（广告文字，如: "\\(本章完\\)"）
  nextPage?: string;       // 章节正文分页链接选择器
}

// 完整书源 JSON 结构
export interface BookSource {
  // 书源名称
  name: string;
  // 网站域名
  url: string;
  // 是否启用
  enabled: boolean;
  search?: RuleSearch;
  detail?: RuleDetail;
  catalog: RuleCatalog;
  content: RuleContent;
}


// {
//   "url": "https://www.wxsy.net/",
//   "name": "顶点小说",
//   "comment": "搜索、详情、章节限流。目录乱序、正文段落被base64编码",
//   "search": {
//     "url": "https://www.wxsy.net/search.html",
//     "method": "post",
//     "data": "{s: %s}",
//     "result": "body > div.container > div:nth-child(1) > div > ul > li",
//     "bookName": "span.s2 > a",
//     "author": "span.s3 > a",
//     "category": "span.s1",
//     "latestChapter": "span.s4 > a",
//     "lastUpdateTime": "span.s5"
//   },
//   "book": {
//     "url": "https://www.wxsy.net/novel/(.*?)/",
//     "coverUrl": ".imgbox > img"
//   },
//   "toc": {
//     "url": "https://www.wxsy.net/novel/%s/chapter_1.html",
//     "list": "/html@js:const childRegex=/\\.section-list\\.ycxsid>li:nth-child\\(\\d+\\){display:none}/g;const lastChildRegex=/\\.section-list\\.ycxsid>li:nth-last-child\\(\\d+\\){display:none}/g;const preHiddenCount=[...r.matchAll(childRegex)].length;const afterHiddenCount=[...r.matchAll(lastChildRegex)].length;r=r.replace(/<ul[^>]*class=\"[^\"]*\\bsection-list\\b[^\"]*\\bycxsid\\b[^\"]*\"[^>]*>([\\s\\S]*?)<\\/ul>/g,(match,liContent)=>{const lis=liContent.match(/<li[\\s\\S]*?<\\/li>/g)||[];const newLis=lis.slice(preHiddenCount,lis.length-afterHiddenCount);return match.replace(liContent,newLis.join(''))});",
//     "item": ".biqunaicc > div:nth-child(2) > div > ul > li > a",
//     "nextPage": ".biqunaicc > div:nth-child(2) > div > div:nth-child(2) > select > option"
//   },
//   "chapter": {
//     "title": "h3",
//     "content": ".row-detail > div > div@js:r=r.replace(/<script>\\s*document\\.writeln\\(qsbs\\.bb\\('([^']+)'\\)\\);\\s*<\\/script>/g,function(a,b){return b});@java:base64.decode()",
//     "paragraphTagClosed": true,
//     "filterTxt": "请勿开启浏览器阅读模式，否则将导致章节内容缺失及无法阅读下一章。|\\(本章完\\)",
//     "filterTag": "h3, div, p[style=font-size:12px;]",
//     "nextPage": ".row.row-detail > div > div > div:nth-child(2) > a:nth-child(4)"
//   }
// }
