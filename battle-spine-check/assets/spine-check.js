if (!window.Vue || !window.spine) {
    document.body.innerHTML = '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f0f1a;color:#fff;font-family:Microsoft YaHei,Noto Sans SC,sans-serif;padding:24px;"><div style="max-width:720px;padding:20px 24px;border:1px solid rgba(255,255,255,.14);border-radius:14px;background:#252540;"><div style="font-size:18px;font-weight:700;margin-bottom:10px;">工具依赖文件缺失</div><div style="line-height:1.7;color:#b8b8c8;">请确认 HTML 同级目录下存在 <span style="font-family:Consolas,monospace;color:#93c5fd;">libs/vue.global.js</span> 和 <span style="font-family:Consolas,monospace;color:#93c5fd;">libs/spine-webgl.js</span>。</div></div></div>';
    throw new Error('工具依赖文件缺失：Vue 或 spine-webgl 未加载');
}
const { createApp, computed, ref, nextTick, onMounted } = Vue;

createApp({
    setup() {
        const isDragging = ref(false);
        const loadedFiles = ref({});
        const loadedFileList = ref([]);
        const uploadedFiles = ref([]);
        const cacheLoading = ref(false);
        const skillFilterText = ref('');
        const scanMode = ref('all');
        const spineBaseUrl = ref('http://192.168.6.1/spine/index.php');
        const results = ref([]);
        const logs = ref([]);
        const isScanning = ref(false);
        const shouldStop = ref(false);
        const progressCurrent = ref(0);
        const progressTotal = ref(0);
        const progressLabel = ref('等待开始');
        const resultFilter = ref('all');
        const pageSize = ref(20);
        const currentPage = ref(1);
        const resultColumns = ref([
            { key: 'status', label: '状态', width: 82, minWidth: 70 },
            { key: 'skill', label: '技能', width: 150, minWidth: 110 },
            { key: 'type', label: '类型', width: 105, minWidth: 90 },
            { key: 'effects', label: '效果列表', width: 170, minWidth: 120 },
            { key: 'route', label: '表现链路', width: 210, minWidth: 150 },
            { key: 'spine', label: 'Spine / 动作', width: 240, minWidth: 160 },
            { key: 'hitEnd', label: 'hit_end', width: 90, minWidth: 80 },
            { key: 'reason', label: '原因', width: 150, minWidth: 110 },
            { key: 'action', label: '操作', width: 88, minWidth: 78 },
            { key: 'detail', label: '详情', width: 360, minWidth: 180 },
        ]);
        const preview = ref({ visible: false, loading: false, error: '', row: null, events: [], fileKeys: [], actions: [], selectedFile: '', selectedAction: '', ctrl: { isLoop: true, timeScale: 10, spineScale: 10, progress: 0, maxProgress: 1000, bgColor: 'transparent' } });
        const spineCache = new Map();
        let gl = null;
        let previewGl = null;
        let previewRenderer = null;
        let previewSkeleton = null;
        let previewState = null;
        let previewFrameId = 0;
        let previewLastTime = 0;
        let previewPlaying = false;
        let previewProgressDragging = false;
        let previewSkeletonOffsetX = 0;
        let previewSkeletonOffsetY = 0;
        const cacheDbName = 'battle-spine-hit-end-tool';
        const cacheDbVersion = 1;
        const cacheStoreName = 'uploaded-config-files';
        let cacheDbPromise = null;

        const canScan = computed(() => !!loadedFiles.value.effectShowData && !!loadedFiles.value.skillEffectData && Object.keys(loadedFiles.value.skillDataMap || {}).length > 0);
        const missingConfigTips = computed(() => {
            const tips = [];
            if (!loadedFiles.value.effectShowData) tips.push('effect_show_data.json/xml');
            if (!loadedFiles.value.skillEffectData) tips.push('skill_effect_data.json/xml');
            if (!Object.keys(loadedFiles.value.skillDataMap || {}).length) tips.push('skill_data*.json/xml');
            return tips;
        });
        const progressPercent = computed(() => progressTotal.value ? Math.round(progressCurrent.value / progressTotal.value * 100) : 0);
        const progressText = computed(() => `${progressLabel.value}（${progressCurrent.value}/${progressTotal.value}）`);
        const spinePageUrlPreview = computed(() => {
            const url = normalizeBaseUrl(spineBaseUrl.value);
            return url.replace(/\/index\.php(?:\?.*)?$/i, '/');
        });
        const filteredResults = computed(() => {
            if (resultFilter.value === 'all') return results.value;
            return results.value.filter(item => item.status === resultFilter.value);
        });
        const totalPages = computed(() => Math.max(1, Math.ceil(filteredResults.value.length / pageSize.value)));
        const pagedResults = computed(() => {
            const safePage = Math.min(currentPage.value, totalPages.value);
            const start = (safePage - 1) * pageSize.value;
            return filteredResults.value.slice(start, start + pageSize.value);
        });
        const pageStart = computed(() => filteredResults.value.length ? (Math.min(currentPage.value, totalPages.value) - 1) * pageSize.value + 1 : 0);
        const pageEnd = computed(() => Math.min(filteredResults.value.length, Math.min(currentPage.value, totalPages.value) * pageSize.value));
        const resultTableWidth = computed(() => resultColumns.value.reduce((sum, col) => sum + col.width, 0));
        const summary = computed(() => {
            const skillSet = new Set(results.value.map(item => item.skillId));
            return {
                skills: skillSet.size,
                total: results.value.length,
                pass: results.value.filter(item => item.status === 'pass').length,
                fail: results.value.filter(item => item.status === 'fail').length,
                skip: results.value.filter(item => item.status === 'skip').length,
            };
        });

        function setResultFilter(filter) {
            resultFilter.value = filter;
            currentPage.value = 1;
        }

        function setPageSize(size) {
            pageSize.value = Number(size) || 20;
            currentPage.value = 1;
        }

        function setCurrentPage(page) {
            const target = Math.max(1, Math.min(Number(page) || 1, totalPages.value));
            currentPage.value = target;
        }

        function startResizeColumn(event, col) {
            const startX = event.clientX;
            const startWidth = col.width;
            const onMove = moveEvent => {
                const nextWidth = Math.max(col.minWidth || 80, startWidth + moveEvent.clientX - startX);
                col.width = nextWidth;
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            };
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        }

        function normalizeBaseUrl(url) {
            const trimmed = (url || '').trim();
            if (!trimmed) return 'http://192.168.6.1/spine/index.php';
            if (/\/spine\/?$/i.test(trimmed)) return trimmed.replace(/\/$/, '') + '/index.php';
            return trimmed;
        }

        function addLog(text, level = 'muted') {
            const date = new Date();
            const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map(v => String(v).padStart(2, '0')).join(':');
            logs.value.unshift({ text, level, time });
            if (logs.value.length > 80) logs.value.pop();
        }

        function openCacheDb() {
            if (!('indexedDB' in window)) return Promise.reject(new Error('当前浏览器不支持 IndexedDB 持久缓存'));
            if (cacheDbPromise) return cacheDbPromise;
            cacheDbPromise = new Promise((resolve, reject) => {
                const request = indexedDB.open(cacheDbName, cacheDbVersion);
                request.onupgradeneeded = event => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains(cacheStoreName)) {
                        db.createObjectStore(cacheStoreName, { keyPath: 'name' });
                    }
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error || new Error('打开 IndexedDB 失败'));
            });
            return cacheDbPromise;
        }

        async function readCacheStore(readonlyFn, mode = 'readonly') {
            const db = await openCacheDb();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(cacheStoreName, mode);
                const store = transaction.objectStore(cacheStoreName);
                const request = readonlyFn(store);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error || new Error('读取缓存失败'));
                transaction.onerror = () => reject(transaction.error || new Error('访问缓存失败'));
            });
        }

        async function loadCachedFiles() {
            cacheLoading.value = true;
            try {
                const items = await readCacheStore(store => store.getAll());
                uploadedFiles.value = (items || [])
                    .filter(item => item && item.name && item.data)
                    .map(item => ({
                        name: item.name,
                        type: item.type || getConfigType(item.name, item.data),
                        data: item.data,
                        enabled: item.enabled !== false,
                        size: Number(item.size || 0),
                        updatedAt: item.updatedAt || 0,
                    }))
                    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
                rebuildEnabledConfig();
                if (uploadedFiles.value.length) addLog(`已从浏览器缓存恢复 ${uploadedFiles.value.length} 个配置文件`, 'success');
            } catch (error) {
                addLog(`读取浏览器缓存失败：${error.message}`, 'warning');
            } finally {
                cacheLoading.value = false;
            }
        }

        async function persistCachedFile(item) {
            try {
                await readCacheStore(store => store.put({
                    name: item.name,
                    type: item.type,
                    data: item.data,
                    enabled: item.enabled !== false,
                    size: Number(item.size || 0),
                    updatedAt: item.updatedAt || Date.now(),
                }), 'readwrite');
            } catch (error) {
                addLog(`写入浏览器缓存失败：${item.name}，${error.message}`, 'warning');
            }
        }

        async function persistCachedEnabled(fileName, enabled) {
            try {
                const oldItem = await readCacheStore(store => store.get(fileName));
                if (!oldItem) return;
                await readCacheStore(store => store.put({ ...oldItem, enabled, updatedAt: oldItem.updatedAt || Date.now() }), 'readwrite');
            } catch (error) {
                addLog(`更新缓存状态失败：${fileName}，${error.message}`, 'warning');
            }
        }

        async function deleteCachedFile(fileName) {
            try {
                await readCacheStore(store => store.delete(fileName), 'readwrite');
            } catch (error) {
                addLog(`移除浏览器缓存失败：${fileName}，${error.message}`, 'warning');
            }
        }

        function formatFileSize(size) {
            const bytes = Number(size || 0);
            if (!bytes) return '大小未知';
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
        }

        function formatCacheTime(timestamp) {
            const time = Number(timestamp || 0);
            if (!time) return '';
            const date = new Date(time);
            const pad = value => String(value).padStart(2, '0');
            return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
        }

        function onDropFiles(event) {
            isDragging.value = false;
            readFiles(Array.from(event.dataTransfer.files || []));
        }

        function onPickFiles(event) {
            readFiles(Array.from(event.target.files || []));
            event.target.value = '';
        }

        async function readFiles(files) {
            const configFiles = files.filter(file => /\.(json|xml)$/i.test(file.name));
            if (!configFiles.length) {
                addLog('未选择 JSON / XML 配置文件', 'warning');
                return;
            }
            for (const file of configFiles) {
                try {
                    const text = await file.text();
                    const data = parseConfigFile(file.name, text);
                    const item = cacheUploadFile(file.name, data, file.size);
                    await persistCachedFile(item);
                    addLog(`加载并缓存配置：${file.name}`, 'success');
                } catch (error) {
                    addLog(`配置解析失败：${file.name}，${error.message}`, 'danger');
                }
            }
            rebuildEnabledConfig();
        }

        function parseConfigFile(fileName, text) {
            if (/\.json$/i.test(fileName)) return JSON.parse(text);
            if (/\.xml$/i.test(fileName)) return parseConfigXml(fileName, text);
            throw new Error('仅支持 .json / .xml 配置文件');
        }

        function parseConfigXml(fileName, text) {
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'application/xml');
            const parseError = doc.querySelector('parsererror');
            if (parseError) throw new Error(parseError.textContent.trim() || 'XML 格式错误');

            const spreadsheetData = parseSpreadsheetXmlConfig(fileName, doc);
            if (spreadsheetData) return spreadsheetData;

            const tableData = parseTableXmlConfig(fileName, doc);
            if (tableData) return tableData;

            throw new Error('无法识别 XML 表结构');
        }

        function parseSpreadsheetXmlConfig(fileName, doc) {
            const worksheets = Array.from(doc.getElementsByTagName('*')).filter(node => localName(node) === 'Worksheet');
            if (!worksheets.length) return null;
            const result = {};
            for (const sheet of worksheets) {
                const rawName = sheet.getAttribute('ss:Name') || sheet.getAttribute('Name') || sheet.getAttribute('name') || '';
                const rows = Array.from(sheet.getElementsByTagName('*')).filter(node => localName(node) === 'Row');
                const records = rowsToXmlRecords(rows);
                assignSpreadsheetSheet(result, fileName, rawName, records);
            }
            return Object.keys(result).length ? result : null;
        }

        function rowsToXmlRecords(rows) {
            if (!rows.length) return [];
            const tableRows = rows.map(row => {
                const cells = [];
                let colIndex = 0;
                for (const cell of Array.from(row.children).filter(node => localName(node) === 'Cell')) {
                    const indexAttr = cell.getAttribute('ss:Index') || cell.getAttribute('Index');
                    if (indexAttr) colIndex = Math.max(0, Number(indexAttr) - 1);
                    cells[colIndex] = getXmlCellText(cell);
                    colIndex++;
                }
                return cells;
            }).filter(row => row.some(value => String(value || '').trim() !== ''));
            if (!tableRows.length) return [];
            const headerIndex = findXmlHeaderRowIndex(tableRows);
            if (headerIndex < 0) return [];
            const headers = tableRows[headerIndex].map(normalizeXmlFieldName);
            return tableRows.slice(headerIndex + 1)
                .map(row => recordFromXmlRow(headers, row))
                .filter(record => Object.keys(record).length > 0);
        }

        function findXmlHeaderRowIndex(tableRows) {
            const englishLike = /^(bid|id|name|owner|group|effect_|show_|skill_|target_|area_|res_|anime_|action_|hurt_|condition_|type|level|lev|cd|score|x_|y_|is_|up_|down_)/i;
            const preferred = tableRows.findIndex(row => row.filter(value => englishLike.test(String(value || '').trim())).length >= 2);
            if (preferred >= 0) return preferred;
            return tableRows.findIndex(row => row.filter(value => String(value || '').trim()).length >= 2);
        }

        function getXmlCellText(cell) {
            const dataNode = Array.from(cell.children).find(node => localName(node) === 'Data');
            return (dataNode || cell).textContent.trim();
        }

        function parseTableXmlConfig(fileName, doc) {
            const result = {};
            assignRepeatedXmlRecordNodes(result, doc);
            const tableNodes = findXmlTableNodes(doc);
            for (const tableNode of tableNodes) {
                const tableName = normalizeXmlTableName(tableNode.getAttribute('name') || tableNode.getAttribute('id') || tableNode.tagName) || inferXmlTableName(fileName);
                const records = Array.from(tableNode.children)
                    .filter(node => !isXmlTableNodeName(localName(node)))
                    .map(xmlElementToRecord)
                    .filter(record => Object.keys(record).length > 0);
                assignXmlTable(result, tableName, records);
            }
            if (Object.keys(result).length) return result;

            const inferredTableName = inferXmlTableName(fileName);
            if (!inferredTableName) return null;
            const root = doc.documentElement;
            const records = Array.from(root.children).map(xmlElementToRecord).filter(record => Object.keys(record).length > 0);
            assignXmlTable(result, inferredTableName, records);
            return Object.keys(result).length ? result : null;
        }

        function assignSpreadsheetSheet(result, fileName, sheetName, records) {
            if (!records.length) return;
            const normalizedSheet = String(sheetName || '').trim();
            const prepared = records.map(record => normalizeSpreadsheetRecord(normalizedSheet, record));
            if (normalizedSheet === '技能') {
                assignXmlTable(result, 'data_get_skill', prepared);
                return;
            }
            if (normalizedSheet === '效果') {
                assignXmlTable(result, 'data_get_effect_desc', prepared);
                return;
            }
            if (normalizedSheet === '特效') {
                assignXmlTable(result, 'data_get_effect_data', prepared);
                return;
            }
            if (normalizedSheet === '技能表现映射') {
                assignXmlTable(result, 'data_get_show_id', prepared);
                return;
            }
            if (normalizedSheet === '先进的技能表现映射') {
                assignXmlTable(result, 'data_get_show2_id', prepared);
                return;
            }
            if (normalizedSheet === '技能效果') {
                assignXmlTable(result, 'data_get_show_data', prepared);
                return;
            }
            const tableName = normalizeXmlTableName(normalizedSheet) || inferXmlTableName(fileName);
            if (tableName) assignXmlTable(result, tableName, prepared);
        }

        function normalizeSpreadsheetRecord(sheetName, record) {
            const next = { ...record };
            for (const key of Object.keys(next)) {
                const normalizedKey = normalizeXmlFieldName(key);
                if (normalizedKey !== key) {
                    next[normalizedKey] = next[key];
                    delete next[key];
                }
            }
            if (next.show_bid !== undefined && next.show_id === undefined) next.show_id = next.show_bid;
            if (sheetName === '效果' && next.group !== undefined && next.hurt_group === undefined) next.hurt_group = next.group;
            if (sheetName === '技能效果' && next.bid !== undefined && next.show_id === undefined) next.show_id = next.bid;
            if (sheetName === '技能效果' && next.camera_action !== undefined && next.scale_act_list === undefined) next.scale_act_list = next.camera_action;
            if (sheetName === '技能效果' && next.shake_id !== undefined && next.shake_id_list === undefined) next.shake_id_list = next.shake_id;
            if (next.is_show_total_number !== undefined && next.is_show_total_num === undefined) next.is_show_total_num = next.is_show_total_number;
            return normalizeXmlRecord(next);
        }

        function assignRepeatedXmlRecordNodes(result, doc) {
            const nodes = Array.from(doc.getElementsByTagName('*'));
            for (const node of nodes) {
                const tableName = normalizeXmlTableName(node.tagName);
                if (!tableName) continue;
                const record = xmlElementToRecord(node);
                if (getXmlRecordId(record) !== '') assignXmlTable(result, tableName, [record]);
            }
        }

        function findXmlTableNodes(doc) {
            const nodes = Array.from(doc.getElementsByTagName('*'));
            return nodes.filter(node => normalizeXmlTableName(node.tagName) && Array.from(node.children).length);
        }

        function isXmlTableNodeName(name) {
            return !!normalizeXmlTableName(name);
        }

        function xmlElementToRecord(element) {
            const record = {};
            for (const attr of Array.from(element.attributes || [])) {
                record[normalizeXmlFieldName(attr.name)] = parseXmlValue(attr.value, attr.name);
            }
            const elementChildren = Array.from(element.children || []);
            if (elementChildren.length) {
                const grouped = new Map();
                for (const child of elementChildren) {
                    const key = normalizeXmlFieldName(localName(child));
                    if (!grouped.has(key)) grouped.set(key, []);
                    grouped.get(key).push(child);
                }
                for (const [key, children] of grouped.entries()) {
                    if (children.length === 1 && !children[0].children.length) {
                        record[key] = parseXmlValue(children[0].textContent.trim(), key);
                    } else {
                        record[key] = children.map(child => xmlElementToRecord(child));
                    }
                }
            } else {
                const text = element.textContent.trim();
                if (text) record.value = parseXmlValue(text, localName(element));
            }
            return normalizeXmlRecord(record);
        }

        function recordFromXmlRow(headers, row) {
            const record = {};
            for (let i = 0; i < headers.length; i++) {
                const key = headers[i];
                if (!key) continue;
                const value = row[i];
                if (value === undefined || value === '') continue;
                record[key] = parseXmlValue(value, key);
            }
            return normalizeXmlRecord(record);
        }

        function normalizeXmlRecord(record) {
            const next = {};
            for (const key in record) {
                next[key] = normalizeXmlFieldValue(key, record[key]);
            }
            return next;
        }

        function normalizeXmlFieldValue(key, value) {
            if (value === undefined || value === null) return value;
            if (Array.isArray(value)) return value;
            const listFields = new Set(['effect_list', 'area_effect_list']);
            if (listFields.has(key)) return parseXmlListValue(value);
            return value;
        }

        function parseXmlValue(rawValue, fieldName = '') {
            const value = String(rawValue ?? '').trim();
            if (!value) return '';
            const jsonLike = value.replace(/'/g, '"');
            if (/^[\[{]/.test(value) && /[\]}]$/.test(value)) {
                try {
                    return JSON.parse(jsonLike);
                } catch (error) {
                    // Fall through to scalar parsing.
                }
            }
            if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
            return value;
        }

        function parseXmlListValue(value) {
            if (Array.isArray(value)) return value;
            if (value === '' || value === 0 || value === '0') return [];
            if (typeof value !== 'string') return [value];
            const trimmed = value.trim();
            if (!trimmed) return [];
            const jsonLike = trimmed.replace(/'/g, '"');
            if (/^\[.*\]$/.test(trimmed)) {
                try {
                    return JSON.parse(jsonLike);
                } catch (error) {
                    // Fall through to delimiter parsing.
                }
            }
            return trimmed.split(/[,，;；|\s]+/).map(item => parseXmlValue(item)).filter(item => item !== '');
        }

        function assignXmlTable(result, tableName, records) {
            const normalizedName = normalizeXmlTableName(tableName);
            if (!normalizedName || !records.length) return;
            if (!result[normalizedName]) result[normalizedName] = {};
            for (const record of records) {
                const id = getXmlRecordId(record, normalizedName);
                if (id === '') continue;
                result[normalizedName][id] = record;
            }
        }

        function getXmlRecordId(record, tableName = '') {
            const idKeysByTable = {
                data_get_skill: ['bid', 'id'],
                data_get_effect_desc: ['bid', 'id'],
                data_get_effect_data: ['bid', 'id'],
                data_get_show_id: ['effect_bid', 'effectBid'],
                data_get_show2_id: ['effect_show_id', 'effectShowId'],
                data_get_show_data: ['show_id', 'showId', 'bid', 'id'],
            };
            const idKeys = idKeysByTable[tableName] || ['id', 'bid', 'effect_bid', 'effectBid', 'show_id', 'effect_show_id'];
            for (const key of idKeys) {
                if (record[key] !== undefined && record[key] !== '') return String(record[key]);
            }
            return '';
        }

        function normalizeXmlTableName(name) {
            const value = localName({ localName: name, nodeName: name }).trim();
            const lower = value.toLowerCase();
            const direct = [
                'data_get_skill',
                'data_get_effect_desc',
                'data_get_show_data',
                'data_get_show_id',
                'data_get_show2_id',
                'data_get_effect_data',
            ];
            if (direct.includes(lower)) return lower;
            if (lower.includes('data_get_skill')) return 'data_get_skill';
            if (lower.includes('data_get_effect_desc')) return 'data_get_effect_desc';
            if (lower.includes('data_get_show_data')) return 'data_get_show_data';
            if (lower.includes('data_get_show2_id')) return 'data_get_show2_id';
            if (lower.includes('data_get_show_id')) return 'data_get_show_id';
            if (lower.includes('data_get_effect_data')) return 'data_get_effect_data';
            return '';
        }

        function inferXmlTableName(fileName) {
            return normalizeXmlTableName(fileName);
        }

        function normalizeXmlFieldName(name) {
            return localName({ localName: name, nodeName: name }).trim();
        }

        function localName(node) {
            return String(node.localName || node.nodeName || '').replace(/^.*:/, '');
        }

        function getConfigType(fileName, data) {
            const lowerName = fileName.toLowerCase();
            if (lowerName.includes('effect_show_data') || data.data_get_show_data || data.data_get_show_id || data.data_get_show2_id) return '表现配置';
            if (lowerName.includes('skill_effect_data') || data.data_get_effect_data) return '特效配置';
            if (lowerName.includes('skill_data') || data.data_get_skill || data.data_get_effect_desc) return '技能配置';
            return '未知配置';
        }

        function cacheUploadFile(fileName, data, size = 0) {
            const oldIndex = uploadedFiles.value.findIndex(item => item.name === fileName);
            const item = { name: fileName, type: getConfigType(fileName, data), data, enabled: true, size: Number(size || 0), updatedAt: Date.now() };
            if (oldIndex >= 0) {
                const next = uploadedFiles.value.slice();
                next[oldIndex] = item;
                uploadedFiles.value = next;
            } else {
                uploadedFiles.value = [...uploadedFiles.value, item];
            }
            uploadedFiles.value = uploadedFiles.value.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
            return item;
        }

        function toggleUploadFile(fileName) {
            const oldItem = uploadedFiles.value.find(item => item.name === fileName);
            const nextEnabled = !(oldItem && oldItem.enabled);
            uploadedFiles.value = uploadedFiles.value.map(item => item.name === fileName ? { ...item, enabled: nextEnabled } : item);
            rebuildEnabledConfig();
            persistCachedEnabled(fileName, nextEnabled);
            addLog(`${nextEnabled ? '启用' : '停用'}配置：${fileName}`, 'info');
        }

        function removeCachedFile(fileName) {
            uploadedFiles.value = uploadedFiles.value.filter(item => item.name !== fileName);
            rebuildEnabledConfig();
            deleteCachedFile(fileName);
            addLog(`已从缓存移除配置：${fileName}`, 'info');
        }

        function rebuildEnabledConfig() {
            loadedFiles.value = {};
            for (const item of uploadedFiles.value) {
                if (!item.enabled) continue;
                mergeConfig(item.name, item.data);
            }
            rebuildLoadedFileList();
        }

        function mergeConfig(fileName, data) {
            const lowerName = fileName.toLowerCase();
            const next = { ...loadedFiles.value };
            if (!next.skillDataMap) next.skillDataMap = {};
            if (!next.effectDescMap) next.effectDescMap = {};
            let merged = false;

            if (lowerName.includes('effect_show_data')) {
                next.effectShowData = mergeConfigTables(next.effectShowData, data, ['data_get_show_data', 'data_get_show_id', 'data_get_show2_id']);
                merged = true;
            }
            if (lowerName.includes('skill_effect_data')) {
                next.skillEffectData = mergeConfigTables(next.skillEffectData, data, ['data_get_effect_data']);
                merged = true;
            }
            if (lowerName.includes('skill_data')) {
                if (data.data_get_skill) Object.assign(next.skillDataMap, data.data_get_skill);
                if (data.data_get_effect_desc) Object.assign(next.effectDescMap, data.data_get_effect_desc);
                merged = true;
            }
            if (data.data_get_show_data || data.data_get_show_id || data.data_get_show2_id) {
                next.effectShowData = mergeConfigTables(next.effectShowData, data, ['data_get_show_data', 'data_get_show_id', 'data_get_show2_id']);
                merged = true;
            }
            if (data.data_get_effect_data) {
                next.skillEffectData = mergeConfigTables(next.skillEffectData, data, ['data_get_effect_data']);
                merged = true;
            }
            if (data.data_get_skill || data.data_get_effect_desc) {
                if (data.data_get_skill) Object.assign(next.skillDataMap, data.data_get_skill);
                if (data.data_get_effect_desc) Object.assign(next.effectDescMap, data.data_get_effect_desc);
                merged = true;
            }
            if (merged) return loadedFiles.value = next;
            addLog(`无法识别配置类型：${fileName}`, 'warning');
        }

        function mergeConfigTables(current, incoming, tableNames) {
            const next = { ...(current || {}) };
            for (const tableName of tableNames) {
                if (!incoming[tableName]) continue;
                next[tableName] = { ...(next[tableName] || {}), ...incoming[tableName] };
            }
            return next;
        }

        function rebuildLoadedFileList() {
            const list = [];
            if (loadedFiles.value.effectShowData) list.push({ name: 'effect_show_data 配置', type: '表现配置' });
            if (loadedFiles.value.skillEffectData) list.push({ name: 'skill_effect_data 配置', type: '特效配置' });
            const skillCount = Object.keys(loadedFiles.value.skillDataMap || {}).length;
            if (skillCount) list.push({ name: `skill_data* 配置（${skillCount}个技能）`, type: '技能配置' });
            const effectDescCount = Object.keys(loadedFiles.value.effectDescMap || {}).length;
            if (effectDescCount) list.push({ name: `data_get_effect_desc（${effectDescCount}个效果）`, type: '效果描述' });
            loadedFileList.value = list;
        }

        function parseSkillFilter() {
            const ids = skillFilterText.value.split(/[\s,，;；]+/).map(item => item.trim()).filter(Boolean);
            return new Set(ids.map(item => String(Number(item) || item)));
        }

        function getSkillCandidates() {
            const skillMap = loadedFiles.value.skillDataMap || {};
            const filter = parseSkillFilter();
            const useFilter = scanMode.value === 'filter' || filter.size > 0;
            const list = [];
            for (const skillId in skillMap) {
                if (useFilter && !filter.has(String(skillId))) continue;
                const skill = skillMap[skillId];
                const effectList = Array.isArray(skill.effect_list) ? skill.effect_list : [];
                const groups = buildEffectShowGroups(effectList);
                const maxShowCount = groups.reduce((max, group) => Math.max(max, group.showCount), 0);
                if (groups.some(group => group.showCount >= 2)) list.push({ skillId, skill, showCount: maxShowCount, hurtGroupCount: groups.length });
            }
            return list.sort((a, b) => Number(a.skillId) - Number(b.skillId));
        }

        function getEffectBid(effectBidRaw) {
            if (effectBidRaw && typeof effectBidRaw === 'object') {
                return String(effectBidRaw.bid || effectBidRaw.effect_bid || effectBidRaw.effectBid || effectBidRaw.id || '');
            }
            return String(effectBidRaw || '');
        }

        function normalizeHurtGroup(value) {
            if (value === undefined || value === null || value === '' || value === 0 || value === '0') {
                return { key: '__default_hurt_group__', label: '未配置' };
            }
            return { key: String(value), label: String(value) };
        }

        function stableStringify(value) {
            if (value === undefined || value === null || value === '' || value === 0 || value === '0') return '__default_condition__';
            if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
            if (typeof value === 'object') {
                const keys = Object.keys(value).sort();
                return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
            }
            return JSON.stringify(value);
        }

        function normalizeConditionParam(value) {
            if (value === undefined || value === null || value === '' || value === 0 || value === '0') {
                return { key: '__default_condition__', label: '未配置' };
            }
            const key = stableStringify(value);
            return { key, label: typeof value === 'object' ? JSON.stringify(value) : String(value) };
        }

        function getEffectHurtGroup(effectBidRaw, effectDesc) {
            const rawHurtGroup = effectBidRaw && typeof effectBidRaw === 'object' && Object.prototype.hasOwnProperty.call(effectBidRaw, 'hurt_group') ? effectBidRaw.hurt_group : undefined;
            const descHurtGroup = effectDesc && Object.prototype.hasOwnProperty.call(effectDesc, 'hurt_group') ? effectDesc.hurt_group : undefined;
            return normalizeHurtGroup(rawHurtGroup !== undefined ? rawHurtGroup : descHurtGroup);
        }

        function getEffectConditionParam(effectBidRaw, effectDesc) {
            const rawCondition = effectBidRaw && typeof effectBidRaw === 'object' && Object.prototype.hasOwnProperty.call(effectBidRaw, 'condition_param') ? effectBidRaw.condition_param : undefined;
            const descCondition = effectDesc && Object.prototype.hasOwnProperty.call(effectDesc, 'condition_param') ? effectDesc.condition_param : undefined;
            return normalizeConditionParam(rawCondition !== undefined ? rawCondition : descCondition);
        }

        function buildEffectShowGroups(effectList) {
            const map = new Map();
            for (const effectBidRaw of effectList || []) {
                const effectBid = getEffectBid(effectBidRaw);
                if (!effectBid) continue;
                const show = resolveShowConfig(effectBid);
                const hurtGroup = getEffectHurtGroup(effectBidRaw, show.effectDesc);
                const condition = getEffectConditionParam(effectBidRaw, show.effectDesc);
                const groupKey = `${hurtGroup.key}|${condition.key}`;
                if (!map.has(groupKey)) {
                    map.set(groupKey, { groupKey, hurtGroup: hurtGroup.label, conditionKey: condition.key, conditionLabel: condition.label, effectBids: [], validShows: [], showCount: 0 });
                }
                const group = map.get(groupKey);
                group.effectBids.push(effectBid);
                if (show.showCfg && show.showId && Number(show.showCfg.show_id || 0) !== 0) {
                    group.validShows.push({ effectBid, show });
                    group.showCount++;
                }
            }
            return Array.from(map.values());
        }

        function getEffectShowCount(effectList) {
            return buildEffectShowGroups(effectList).reduce((sum, group) => sum + group.showCount, 0);
        }

        function resolveShowConfig(effectBid) {
            const files = loadedFiles.value;
            const effectShowData = files.effectShowData || {};
            const effectDesc = (files.effectDescMap || {})[effectBid];
            const effectShowId = effectDesc ? Number(effectDesc.effect_show_id || 0) : 0;
            let showId = 0;
            let show2Cfg = null;
            let route = 'old';
            if (effectShowId && effectShowData.data_get_show2_id && effectShowData.data_get_show2_id[effectShowId]) {
                show2Cfg = effectShowData.data_get_show2_id[effectShowId];
                if (typeof show2Cfg === 'number') showId = show2Cfg;
                else showId = Number(show2Cfg.show_id || 0);
                route = 'new';
            }
            if (!showId && effectShowData.data_get_show_id) {
                const oldShow = effectShowData.data_get_show_id[effectBid];
                if (typeof oldShow === 'number') showId = oldShow;
                else if (oldShow && typeof oldShow === 'object') showId = Number(oldShow.show_id || 0);
                route = 'old';
            }
            const showCfg = showId && effectShowData.data_get_show_data ? effectShowData.data_get_show_data[showId] : null;
            return { effectBid, effectDesc, effectShowId, showId, showCfg, show2Cfg, route };
        }

        function buildCheckItems(skillId, skill) {
            const effectList = Array.isArray(skill.effect_list) ? skill.effect_list : [];
            const groups = buildEffectShowGroups(effectList).filter(group => group.showCount >= 2);
            const items = [];
            for (const group of groups) {
                const expectedHitEnd = Math.max(0, group.showCount - 1);
                const hasAreaShow = group.validShows.some(item => hasAreaEffectList(item.show));
                const checkShows = hasAreaShow ? group.validShows.filter(item => hasAreaEffectList(item.show)) : group.validShows;
                for (const item of checkShows) {
                    const base = {
                        skillId,
                        skillName: skill.name || '',
                        owner: skill.owner || '',
                        targetType: skill.target_type,
                        effectListText: JSON.stringify(effectList),
                        hurtGroup: group.hurtGroup,
                        conditionKey: group.conditionKey,
                        conditionLabel: group.conditionLabel,
                        groupKey: group.groupKey,
                        hurtGroupEffectListText: group.effectBids.join(','),
                        showCount: group.showCount,
                        expectedHitEnd,
                        effectBid: item.effectBid,
                        effectShowId: item.show.effectShowId,
                        showId: item.show.showId,
                    };
                    items.push(...buildShowCheckItems(base, item.show));
                }
            }
            return mergeDuplicateCheckItems(items);
        }

        function hasAreaEffectList(show) {
            return !!(show && show.showCfg && Array.isArray(show.showCfg.area_effect_list) && show.showCfg.area_effect_list.filter(Boolean).length > 0);
        }

        function buildShowCheckItems(base, show) {
            const areaEffectList = Array.isArray(show.showCfg.area_effect_list) ? show.showCfg.area_effect_list.filter(Boolean) : [];
            if (areaEffectList.length > 0) {
                return buildAreaCheckItems(base, areaEffectList);
            }
            const spineId = show.show2Cfg && typeof show.show2Cfg === 'object' ? String(show.show2Cfg.skill_modle_res || '') : '';
            const actionName = String(show.showCfg.anime_user_atk || '');
            if (!spineId || spineId === '0') {
                return [];
            }
            if (!actionName) {
                return [{ ...base, isArea: false, status: 'skip', spineId, actionName, reason: '缺少动作名', message: '单体技能已配置表现，但缺少 anime_user_atk 动作名', actualHitEnd: -1, actualHitEndText: '-' }];
            }
            return [{ ...base, isArea: false, spineId, actionName, message: '待检查' }];
        }

        function mergeDuplicateCheckItems(items) {
            const map = new Map();
            for (const item of items) {
                const key = [item.skillId, item.groupKey || `${item.hurtGroup || 'none'}|${item.conditionKey || 'none'}`, item.isArea ? 'area' : 'single', item.spineId || '', item.actionName || '', item.areaEffectId || '', item.areaTag || ''].join('|');
                if (!map.has(key)) {
                    map.set(key, item);
                    continue;
                }
                const old = map.get(key);
                old.effectBid = `${old.effectBid},${item.effectBid}`;
                old.effectShowId = `${old.effectShowId || '-'},${item.effectShowId || '-'}`;
                old.showId = `${old.showId || '-'},${item.showId || '-'}`;
            }
            return Array.from(map.values());
        }

        function buildAreaCheckItems(base, areaEffectList) {
            const effectData = (loadedFiles.value.skillEffectData || {}).data_get_effect_data || {};
            const alternatives = [];
            const missingEffectIds = [];
            const missingActionMsgs = [];
            for (const effectId of areaEffectList) {
                const cfg = effectData[effectId];
                if (!cfg) {
                    missingEffectIds.push(effectId);
                    continue;
                }
                const pairs = [
                    { spineId: cfg.res_up, actionName: cfg.up_action_name, tag: 'up' },
                    { spineId: cfg.res_down, actionName: cfg.down_action_name, tag: 'down' },
                ];
                for (const pair of pairs) {
                    const spineId = String(pair.spineId || '');
                    const actionName = String(pair.actionName || '');
                    if (!spineId || spineId === '0') continue;
                    if (!actionName) {
                        missingActionMsgs.push(`${effectId}/${pair.tag}`);
                        continue;
                    }
                    alternatives.push({ effectId, spineId, actionName, tag: pair.tag });
                }
            }
            if (alternatives.length) {
                return [{
                    ...base,
                    isArea: true,
                    spineId: alternatives.map(item => `${item.effectId}.${item.tag}:${item.spineId}`).join(' / '),
                    actionName: alternatives.map(item => `${item.effectId}.${item.tag}:${item.actionName}`).join(' / '),
                    areaEffectId: areaEffectList.join(','),
                    areaTag: 'any',
                    areaAlternatives: alternatives,
                    areaMissingEffectIds: missingEffectIds,
                    areaMissingActionMsgs: missingActionMsgs,
                    message: `群攻特效 ${areaEffectList.join(',')}（area_effect_list 任意一个 Spine 资源通过即可）`,
                }];
            }
            if (missingEffectIds.length) {
                return [{ ...base, isArea: true, status: 'skip', reason: '群攻特效配置缺失', message: `找不到群攻特效配置：${missingEffectIds.join(',')}`, actualHitEnd: -1, actualHitEndText: '-' }];
            }
            if (missingActionMsgs.length) {
                return [{ ...base, isArea: true, spineId: '', actionName: '', status: 'skip', reason: '群攻特效动作名缺失', message: `群攻特效 ${missingActionMsgs.join('、')} 缺少动作名，且无可检查候选`, actualHitEnd: -1, actualHitEndText: '-' }];
            }
            return [];
        }

        async function startScan() {
            if (!canScan.value || isScanning.value) return;
            isScanning.value = true;
            shouldStop.value = false;
            results.value = [];
            currentPage.value = 1;
            logs.value = [];

            const candidates = getSkillCandidates();
            progressCurrent.value = 0;
            progressTotal.value = candidates.length;
            progressLabel.value = `准备检查 ${candidates.length} 个候选技能`;
            addLog(`候选技能：${candidates.length}。将按 hurt_group + condition_param 组合分组；未配置 hurt_group 或 condition_param 会作为默认值参与同组归并。`, 'info');

            let checkedItemCount = 0;
            let ignoredNoShowCount = 0;
            for (let i = 0; i < candidates.length; i++) {
                if (shouldStop.value) break;
                const candidate = candidates[i];
                progressLabel.value = `解析技能 ${candidate.skillId}`;

                const items = buildCheckItems(candidate.skillId, candidate.skill);
                if (!items.length) {
                    ignoredNoShowCount++;
                    progressCurrent.value++;
                    if (i % 20 === 0) await nextFrame();
                    continue;
                }

                for (const item of items) {
                    if (shouldStop.value) break;
                    checkedItemCount++;
                    progressLabel.value = `${item.skillId} ${item.spineId || ''}/${item.actionName || ''}`;
                    await checkOneItem(item);
                    await nextFrame();
                }
                progressCurrent.value++;
                if (i % 10 === 0) await nextFrame();
            }

            progressLabel.value = shouldStop.value ? '已停止' : '检查完成';
            addLog(`${progressLabel.value}：检查项 ${checkedItemCount} 个，忽略无表现技能 ${ignoredNoShowCount} 个。`, shouldStop.value ? 'warning' : 'success');
            isScanning.value = false;
        }

        async function checkOneItem(item) {
            if (item.status === 'skip') {
                results.value.push(finalizeRow(item));
                return;
            }
            if (item.isArea && Array.isArray(item.areaAlternatives) && item.areaAlternatives.length) {
                await checkAreaAlternativeItem(item);
                return;
            }
            try {
                const hitEndInfo = await getHitEndCount(item.spineId, item.actionName);
                const pass = hitEndInfo.count >= item.expectedHitEnd;
                results.value.push(finalizeRow({
                    ...item,
                    status: pass ? 'pass' : 'fail',
                    reason: pass ? '检查通过' : 'hit_end 数量不足',
                    actualHitEnd: hitEndInfo.count,
                    actualHitEndText: String(hitEndInfo.count),
                    fileKey: hitEndInfo.fileKey,
                    message: pass ? `通过：${item.message}` : `失败原因：hit_end 数量不足。期望至少 ${item.expectedHitEnd} 个，实际 ${hitEndInfo.count} 个。${item.message}`,
                }));
            } catch (error) {
                results.value.push(finalizeRow({
                    ...item,
                    status: 'skip',
                    reason: 'Spine 加载或解析失败',
                    actualHitEnd: -1,
                    actualHitEndText: '-',
                    message: `跳过原因：加载或解析 Spine 失败。${error.message}`,
                }));
            }
        }

        async function checkAreaAlternativeItem(item) {
            const details = [];
            const effectIdsWithHitEnd = new Set();
            let bestInfo = null;
            let passInfo = null;
            for (const alt of item.areaAlternatives) {
                try {
                    const hitEndInfo = await getHitEndCount(alt.spineId, alt.actionName);
                    const pass = hitEndInfo.count >= item.expectedHitEnd;
                    const info = { ...hitEndInfo, ...alt, pass };
                    details.push(`${alt.effectId}.${alt.tag}:${alt.spineId}/${alt.actionName}=${hitEndInfo.count}`);
                    if (hitEndInfo.count > 0) effectIdsWithHitEnd.add(String(alt.effectId));
                    if (!bestInfo || hitEndInfo.count > bestInfo.count) bestInfo = info;
                    if (pass && !passInfo) passInfo = info;
                } catch (error) {
                    details.push(`${alt.effectId}.${alt.tag}:${alt.spineId}/${alt.actionName}=加载或解析失败(${error.message})`);
                }
            }
            const warningText = effectIdsWithHitEnd.size > 1 ? `警告：area_effect_list 中存在多个 effectId 含 hit_end（${Array.from(effectIdsWithHitEnd).join(',')}），预期有且仅有 1 个 effectId 资源包含 hit_end。` : '';
            const extraTips = [];
            if (Array.isArray(item.areaMissingEffectIds) && item.areaMissingEffectIds.length) extraTips.push(`缺失配置：${item.areaMissingEffectIds.join(',')}`);
            if (Array.isArray(item.areaMissingActionMsgs) && item.areaMissingActionMsgs.length) extraTips.push(`缺动作：${item.areaMissingActionMsgs.join('、')}`);
            const suffix = [warningText, ...extraTips].filter(Boolean).join(' ');
            if (passInfo) {
                results.value.push(finalizeRow({
                    ...item,
                    spineId: passInfo.spineId,
                    actionName: passInfo.actionName,
                    areaEffectId: passInfo.effectId,
                    areaTag: passInfo.tag,
                    status: 'pass',
                    reason: warningText ? '检查通过（多特效含 hit_end）' : '检查通过',
                    actualHitEnd: passInfo.count,
                    actualHitEndText: String(passInfo.count),
                    fileKey: passInfo.fileKey,
                    message: `通过：area_effect_list 中 ${passInfo.effectId}.${passInfo.tag} 资源 hit_end 达标，任意一个 Spine 资源通过即可。明细：${details.join('；')}${suffix ? `。${suffix}` : ''}`,
                }));
                return;
            }
            if (!bestInfo) {
                results.value.push(finalizeRow({
                    ...item,
                    status: 'skip',
                    reason: 'Spine 加载或解析失败',
                    actualHitEnd: -1,
                    actualHitEndText: '-',
                    fileKey: '',
                    message: `跳过原因：area_effect_list 中所有 Spine 资源均加载或解析失败。明细：${details.join('；')}${suffix ? `。${suffix}` : ''}`,
                }));
                return;
            }
            results.value.push(finalizeRow({
                ...item,
                spineId: bestInfo.spineId,
                actionName: bestInfo.actionName,
                areaEffectId: bestInfo.effectId,
                areaTag: bestInfo.tag,
                status: 'fail',
                reason: warningText ? 'hit_end 数量不足（多特效含 hit_end）' : 'hit_end 数量不足',
                actualHitEnd: bestInfo.count,
                actualHitEndText: String(bestInfo.count),
                fileKey: bestInfo.fileKey,
                message: `失败原因：area_effect_list 中没有任意一个 Spine 资源达到期望 hit_end 数量 ${item.expectedHitEnd}。明细：${details.join('；')}${suffix ? `。${suffix}` : ''}`,
            }));
        }

        function finalizeRow(row) {
            return {
                id: `${row.skillId}_${row.spineId || 'none'}_${row.actionName || 'none'}_${results.value.length}`,
                actualHitEnd: typeof row.actualHitEnd === 'number' ? row.actualHitEnd : -1,
                actualHitEndText: row.actualHitEndText || '-',
                fileKey: row.fileKey || '',
                status: row.status || 'skip',
                reason: row.reason || '',
                ...row,
            };
        }

        function stopScan() {
            shouldStop.value = true;
            addLog('正在停止扫描，当前 Spine 解析结束后生效', 'warning');
        }

        function clearResults() {
            results.value = [];
            currentPage.value = 1;
            logs.value = [];
            progressCurrent.value = 0;
            progressTotal.value = 0;
            progressLabel.value = '等待开始';
        }

        async function getHitEndCount(spineId, actionName) {
            if (!spineId || !actionName) throw new Error('缺少 Spine ID 或动作名');
            const cacheKey = `${spineId}::${actionName}`;
            if (spineCache.has(cacheKey)) return spineCache.get(cacheKey);
            const files = await getSpineFiles(spineId);
            const fileKeys = Object.keys(files);
            if (!fileKeys.length) throw new Error(`未获取到 ${spineId} 的文件列表`);
            let lastError = null;
            for (const fileKey of fileKeys) {
                try {
                    const skeletonData = await loadSkeletonData(spineId, fileKey, files[fileKey] || []);
                    const animation = skeletonData.animations.find(item => item.name === actionName);
                    if (!animation) continue;
                    const count = countAnimationEvent(animation, 'hit_end');
                    const info = { count, fileKey };
                    spineCache.set(cacheKey, info);
                    return info;
                } catch (error) {
                    lastError = error;
                }
            }
            if (lastError) throw lastError;
            throw new Error(`动作不存在：${actionName}，已查找文件 ${fileKeys.join(', ')}`);
        }

        async function getSpineFiles(spineId) {
            const cacheKey = `${spineId}::__files`;
            if (spineCache.has(cacheKey)) return spineCache.get(cacheKey);
            const base = normalizeBaseUrl(spineBaseUrl.value);
            const pageUrl = base.replace(/\/index\.php(?:\?.*)?$/i, '/') + `?spine_id=${encodeURIComponent(spineId)}&time=${Date.now()}`;
            const response = await fetch(pageUrl, { cache: 'no-store' });
            if (!response.ok) throw new Error(`文件列表请求失败：HTTP ${response.status}`);
            const html = await response.text();
            const match = html.match(/const\s+data\s*=\s*(\{[\s\S]*?\});/);
            if (!match) throw new Error('无法从页面解析 files 数据');
            const data = JSON.parse(match[1]);
            const files = data.files || {};
            spineCache.set(cacheKey, files);
            return files;
        }

        async function loadSkeletonData(spineId, fileKey, pngFiles, targetGl = null) {
            const useGl = targetGl || ensureWebgl();
            const base = normalizeBaseUrl(spineBaseUrl.value);
            const assetManager = new spine.webgl.AssetManager(useGl);
            const fileUrl = fileName => `${base}?spine_id=${encodeURIComponent(spineId)}&spine_file=${fileName}`;
            const skelUrl = fileUrl(`${fileKey}.skel`);
            const atlasUrl = fileUrl(`${fileKey}.atlas`);

            // 第一阶段：先加载 skeleton 与 atlas 文本。事件帧解析只需要 skel，但渲染必须保证 atlas 引用的贴图都已加载。
            assetManager.loadBinary(skelUrl);
            assetManager.loadText(atlasUrl);
            await waitAssetManager(assetManager, 15000);

            const atlasText = assetManager.get(atlasUrl);
            const textureFiles = new Set();
            textureFiles.add(`${fileKey}.png`);
            for (const pngFile of pngFiles || []) {
                const name = String(pngFile || '').trim();
                if (name) textureFiles.add(/\.(png|jpg|jpeg|webp)$/i.test(name) ? name : `${name}.png`);
            }
            for (const page of parseAtlasTexturePages(atlasText)) {
                textureFiles.add(page);
            }

            // 第二阶段：按 atlas 实际 page 名加载贴图，避免只解析到事件、但无附件贴图可绘制导致画布空白。
            for (const textureFile of textureFiles) {
                assetManager.loadTexture(fileUrl(textureFile));
            }
            await waitAssetManager(assetManager, 15000);

            const atlas = new spine.TextureAtlas(atlasText, path => {
                const directUrl = fileUrl(path);
                const direct = safeAssetGet(assetManager, directUrl);
                if (direct) return direct;
                const normalized = /\.(png|jpg|jpeg|webp)$/i.test(path) ? path : `${path}.png`;
                return safeAssetGet(assetManager, fileUrl(normalized));
            });
            const atlasLoader = new spine.AtlasAttachmentLoader(atlas);
            const skeletonBinary = new spine.SkeletonBinary(atlasLoader);
            return skeletonBinary.readSkeletonData(assetManager.get(skelUrl));
        }

        function parseAtlasTexturePages(atlasText) {
            const pages = [];
            const lines = String(atlasText || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (/\.(png|jpg|jpeg|webp)$/i.test(line)) {
                    pages.push(line);
                    continue;
                }
                const next = lines[i + 1] || '';
                if (!line.includes(':') && /^size\s*:/i.test(next)) {
                    pages.push(line);
                }
            }
            return pages;
        }

        function safeAssetGet(assetManager, url) {
            try {
                return assetManager.get(url);
            } catch (error) {
                return null;
            }
        }

        function ensureWebgl() {
            if (gl) return gl;
            const canvas = document.getElementById('hiddenCanvas');
            gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
            if (!gl) throw new Error('浏览器不支持 WebGL，无法解析 Spine');
            return gl;
        }

        function waitAssetManager(assetManager, timeoutMs) {
            const start = Date.now();
            return new Promise((resolve, reject) => {
                const tick = () => {
                    if (assetManager.isLoadingComplete()) return resolve();
                    if (Date.now() - start > timeoutMs) return reject(new Error('Spine 资源加载超时'));
                    requestAnimationFrame(tick);
                };
                tick();
            });
        }

        function countAnimationEvent(animation, eventName) {
            let count = 0;
            for (const timeline of animation.timelines || []) {
                if (timeline instanceof spine.EventTimeline) {
                    for (const event of timeline.events || []) {
                        if (event && event.data && event.data.name === eventName) count++;
                    }
                }
            }
            return count;
        }

        function collectAnimationEvents(animation) {
            const list = [];
            for (const timeline of animation.timelines || []) {
                if (timeline instanceof spine.EventTimeline) {
                    for (let i = 0; i < timeline.frames.length; i++) {
                        const event = timeline.events[i];
                        list.push({
                            name: event?.data?.name || '',
                            time: timeline.frames[i] || 0,
                        });
                    }
                }
            }
            return list.sort((a, b) => a.time - b.time);
        }

        async function openPreview(row) {
            closePreviewRenderOnly();
            preview.value = {
                visible: true,
                loading: true,
                error: '',
                row,
                events: [],
                fileKeys: [],
                actions: [],
                selectedFile: row.fileKey || '',
                selectedAction: row.actionName || '',
                ctrl: { isLoop: true, timeScale: 10, spineScale: 10, progress: 0, maxProgress: 1000, bgColor: 'transparent' }
            };
            await nextTick();
            await nextFrame();
            try {
                const files = await getSpineFiles(row.spineId);
                const fileKeys = Object.keys(files);
                if (!fileKeys.length) throw new Error(`未获取到 ${row.spineId} 的文件列表`);
                const selectedFile = row.fileKey && files[row.fileKey] !== undefined ? row.fileKey : fileKeys[0];
                preview.value = { ...preview.value, fileKeys, selectedFile };
                await loadPreviewSpine(selectedFile, row.actionName);
            } catch (error) {
                preview.value = { ...preview.value, loading: false, error: error.message };
            }
        }

        async function loadPreviewSpine(fileKey, preferActionName = '') {
            closePreviewRenderOnly();
            preview.value = { ...preview.value, loading: true, error: '', events: [], actions: [], selectedFile: fileKey };
            await nextTick();
            await nextFrame();
            try {
                const row = preview.value.row;
                const canvas = document.getElementById('previewCanvas');
                previewGl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
                if (!previewGl) throw new Error('浏览器不支持 WebGL，无法预览 Spine');
                previewRenderer = new spine.webgl.SceneRenderer(canvas, previewGl, { premultipliedAlpha: true });

                const files = await getSpineFiles(row.spineId);
                const skeletonData = await loadSkeletonData(row.spineId, fileKey, files[fileKey] || [], previewGl);
                const actions = skeletonData.animations.map(item => item.name);
                const selectedAction = actions.includes(preferActionName) ? preferActionName : (actions.includes(row.actionName) ? row.actionName : actions[0]);
                if (!selectedAction) throw new Error(`文件 ${fileKey} 下没有动作`);
                const animation = skeletonData.animations.find(item => item.name === selectedAction);

                previewSkeleton = new spine.Skeleton(skeletonData);
                previewSkeleton.scaleX = preview.value.ctrl.spineScale * 0.1;
                previewSkeleton.scaleY = preview.value.ctrl.spineScale * 0.1;
                previewSkeleton.x = 0;
                previewSkeleton.y = 0;

                const animationStateData = new spine.AnimationStateData(previewSkeleton.data);
                previewState = new spine.AnimationState(animationStateData);
                const entry = previewState.setAnimation(0, selectedAction, preview.value.ctrl.isLoop);
                entry.timeScale = preview.value.ctrl.timeScale * 0.1;
                previewLastTime = Date.now() / 1000;
                previewPlaying = true;

                const maxMs = Math.round(animation.duration * 1000);
                preview.value = {
                    ...preview.value,
                    loading: false,
                    selectedFile: fileKey,
                    selectedAction,
                    actions,
                    events: collectAnimationEvents(animation),
                    ctrl: { ...preview.value.ctrl, maxProgress: maxMs || 1000, progress: 0 }
                };
                renderPreview();
            } catch (error) {
                preview.value = { ...preview.value, loading: false, error: error.message };
            }
        }

        function calculateSkeletonBounds(skeleton) {
            skeleton.setToSetupPose();
            skeleton.updateWorldTransform();
            const offset = new spine.Vector2();
            const size = new spine.Vector2();
            skeleton.getBounds(offset, size, []);
            return { offset, size };
        }

        function calcAutoScale(skeleton, canvasW, canvasH) {
            // 以 scale=1 计算骨骼包围盒，再反算让骨骼填充 canvas 的 60%
            skeleton.scaleX = 1;
            skeleton.scaleY = 1;
            const bounds = calculateSkeletonBounds(skeleton);
            const bw = bounds.size.x || 1;
            const bh = bounds.size.y || 1;
            const fitScale = Math.min((canvasW * 0.6) / bw, (canvasH * 0.6) / bh);
            // 限定在 0.01 ~ 5 之间
            return Math.min(5, Math.max(0.01, fitScale));
        }

        function renderPreview() {
            if (!preview.value.visible || !previewRenderer || !previewSkeleton || !previewState || !previewGl) return;
            const now = Date.now() / 1000;
            const delta = now - previewLastTime;
            previewLastTime = now;

            previewGl.clearColor(0, 0, 0, 0);
            previewGl.clear(previewGl.COLOR_BUFFER_BIT);

            if (previewPlaying && !previewProgressDragging) {
                previewState.update(delta);
                const cur = previewState.getCurrent(0);
                if (cur) {
                    const duration = preview.value.ctrl.maxProgress / 1000 || 1;
                    const ms = Math.round((cur.trackTime % duration) * 1000);
                    preview.value.ctrl.progress = Math.min(Math.max(ms, 0), preview.value.ctrl.maxProgress);
                }
            }

            previewState.apply(previewSkeleton);
            previewSkeleton.updateWorldTransform();

            previewRenderer.camera.position.x = previewSkeleton.x;
            previewRenderer.camera.position.y = previewSkeleton.y;
            previewRenderer.resize();
            previewRenderer.begin();
            previewRenderer.drawSkeleton(previewSkeleton, false);
            previewRenderer.end();

            previewFrameId = requestAnimationFrame(renderPreview);
        }

        function onPreviewLoopChange() {
            if (!previewState || !preview.value.selectedAction) return;
            const cur = previewState.getCurrent(0);
            const currentTime = cur ? cur.trackTime : 0;
            const entry = previewState.setAnimation(0, preview.value.selectedAction, preview.value.ctrl.isLoop);
            entry.trackTime = currentTime;
            entry.timeScale = preview.value.ctrl.timeScale * 0.1;
            previewPlaying = true;
        }

        function playPreviewOnce() {
            if (!previewState || !preview.value.selectedAction) return;
            preview.value.ctrl.isLoop = false;
            const entry = previewState.setAnimation(0, preview.value.selectedAction, false);
            entry.timeScale = preview.value.ctrl.timeScale * 0.1;
            previewPlaying = true;
        }

        function onPreviewSpeedChange() {
            if (!previewState) return;
            const entry = previewState.getCurrent(0);
            if (entry) entry.timeScale = preview.value.ctrl.timeScale * 0.1;
        }

        function onPreviewScaleChange() {
            if (!previewSkeleton) return;
            const scale = preview.value.ctrl.spineScale * 0.1;
            previewSkeleton.scaleX = scale;
            previewSkeleton.scaleY = scale;
        }

        function onPreviewProgressDown() {
            previewProgressDragging = true;
        }

        function onPreviewProgressInput() {
            if (!previewState || !previewSkeleton || !preview.value.selectedAction) return;
            const timeSec = preview.value.ctrl.progress / 1000;
            const entry = previewState.setAnimation(0, preview.value.selectedAction, false);
            entry.timeScale = 0;
            entry.trackTime = timeSec;
            previewState.apply(previewSkeleton);
            previewSkeleton.updateWorldTransform();
            if (previewRenderer && previewGl) {
                previewGl.clearColor(0, 0, 0, 0);
                previewGl.clear(previewGl.COLOR_BUFFER_BIT);
                previewRenderer.camera.position.x = previewSkeleton.x;
                previewRenderer.camera.position.y = previewSkeleton.y;
                previewRenderer.resize();
                previewRenderer.begin();
                previewRenderer.drawSkeleton(previewSkeleton, false);
                previewRenderer.end();
            }
        }

        function onPreviewProgressUp() {
            previewProgressDragging = false;
            if (!previewState || !preview.value.selectedAction) return;
            const timeSec = preview.value.ctrl.progress / 1000;
            const entry = previewState.setAnimation(0, preview.value.selectedAction, preview.value.ctrl.isLoop);
            entry.trackTime = timeSec;
            entry.timeScale = preview.value.ctrl.timeScale * 0.1;
            previewPlaying = true;
            previewLastTime = Date.now() / 1000;
        }

        function setPreviewBg(color) {
            preview.value.ctrl.bgColor = color;
        }

        async function reloadPreviewSelected() {
            if (!preview.value.selectedFile) return;
            await loadPreviewSpine(preview.value.selectedFile, preview.value.selectedAction);
        }

        function playPreviewSelectedAction() {
            if (!previewState || !previewSkeleton || !preview.value.selectedAction) return;
            const animation = previewSkeleton.data.animations.find(item => item.name === preview.value.selectedAction);
            if (!animation) return;
            const entry = previewState.setAnimation(0, preview.value.selectedAction, preview.value.ctrl.isLoop);
            entry.timeScale = preview.value.ctrl.timeScale * 0.1;
            preview.value.events = collectAnimationEvents(animation);
            preview.value.ctrl.progress = 0;
            preview.value.ctrl.maxProgress = Math.round(animation.duration * 1000) || 1000;
            previewPlaying = true;
            previewLastTime = Date.now() / 1000;
        }

        function closePreviewRenderOnly() {
            if (previewFrameId) cancelAnimationFrame(previewFrameId);
            previewFrameId = 0;
            previewRenderer = null;
            previewSkeleton = null;
            previewState = null;
            previewGl = null;
            previewPlaying = false;
            previewProgressDragging = false;
        }

        function closePreview() {
            closePreviewRenderOnly();
            preview.value = { visible: false, loading: false, error: '', row: null, events: [], fileKeys: [], actions: [], selectedFile: '', selectedAction: '', ctrl: { isLoop: true, timeScale: 10, spineScale: 10, progress: 0, maxProgress: 1000, bgColor: 'transparent' } };
        }

        function nextFrame() {
            return new Promise(resolve => requestAnimationFrame(resolve));
        }

        function statusText(status) {
            if (status === 'pass') return '通过';
            if (status === 'fail') return '失败';
            if (status === 'skip') return '跳过';
            return status;
        }

        function exportReport() {
            const report = {
                exportTime: new Date().toISOString(),
                summary: summary.value,
                results: results.value,
            };
            const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `battle_spine_hit_end_report_${Date.now()}.json`;
            link.click();
            URL.revokeObjectURL(url);
        }

        onMounted(() => {
            loadCachedFiles();
        });

        return {
            isDragging,
            loadedFileList,
            uploadedFiles,
            cacheLoading,
            skillFilterText,
            scanMode,
            spineBaseUrl,
            spinePageUrlPreview,
            results,
            logs,
            isScanning,
            canScan,
            missingConfigTips,
            progressPercent,
            progressText,
            progressCurrent,
            progressTotal,
            resultFilter,
            pageSize,
            currentPage,
            resultColumns,
            resultTableWidth,
            totalPages,
            pagedResults,
            pageStart,
            pageEnd,
            preview,
            filteredResults,
            summary,
            onDropFiles,
            onPickFiles,
            toggleUploadFile,
            removeCachedFile,
            formatFileSize,
            formatCacheTime,
            setResultFilter,
            setPageSize,
            setCurrentPage,
            startResizeColumn,
            startScan,
            stopScan,
            clearResults,
            exportReport,
            openPreview,
            closePreview,
            statusText,
            onPreviewLoopChange,
            playPreviewOnce,
            onPreviewSpeedChange,
            onPreviewScaleChange,
            onPreviewProgressDown,
            onPreviewProgressUp,
            onPreviewProgressInput,
            setPreviewBg,
            reloadPreviewSelected,
            playPreviewSelectedAction,
        };
    }
}).mount('#app');
