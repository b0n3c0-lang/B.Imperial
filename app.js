/* Barbearia Imperial — app.js
   Agenda eletrônica + clientes + contagem de serviços. Dados 100% locais (IndexedDB). */

        // =====================================================================
        // BANCO LOCAL (IndexedDB) — roda 100% no aparelho, sem internet e sem Firebase.
        // Essa camada imita a API do Firestore (collection/doc/where/get/add/...) pra
        // todo o resto do código continuar igual. Os dados ficam guardados só neste
        // navegador/aparelho — não sincronizam entre dispositivos diferentes.
        // =====================================================================
        const IDB_NAME = 'BarbeariaImperialDB';
        const IDB_VERSION = 1;
        const IDB_STORES = ['bookings', 'clients', 'settings'];

        function idbOpen() {
            return new Promise((resolve, reject) => {
                const req = indexedDB.open(IDB_NAME, IDB_VERSION);
                req.onupgradeneeded = (e) => {
                    const idb = e.target.result;
                    IDB_STORES.forEach(name => {
                        if (!idb.objectStoreNames.contains(name)) idb.createObjectStore(name, { keyPath: 'id' });
                    });
                };
                req.onsuccess = (e) => resolve(e.target.result);
                req.onerror = (e) => reject(e.target.error);
            });
        }
        const idbPromise = idbOpen();

        function genId() { return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10); }
        function reqToPromise(req) { return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }

        async function idbGetAll(storeName) {
            const idb = await idbPromise;
            return reqToPromise(idb.transaction(storeName, 'readonly').objectStore(storeName).getAll());
        }
        async function idbGetOne(storeName, id) {
            const idb = await idbPromise;
            return reqToPromise(idb.transaction(storeName, 'readonly').objectStore(storeName).get(id));
        }
        async function idbPut(storeName, obj) {
            const idb = await idbPromise;
            const tx = idb.transaction(storeName, 'readwrite');
            await reqToPromise(tx.objectStore(storeName).put(obj));
            return obj;
        }
        async function idbDelete(storeName, id) {
            const idb = await idbPromise;
            const tx = idb.transaction(storeName, 'readwrite');
            await reqToPromise(tx.objectStore(storeName).delete(id));
        }

        function makeSnapshot(docs) {
            return {
                docs: docs.map(d => ({ id: d.id, data: () => Object.assign({}, d) })),
                empty: docs.length === 0,
                size: docs.length,
                forEach(cb) { docs.forEach(d => cb({ id: d.id, data: () => Object.assign({}, d) })); }
            };
        }
        function applyWhere(docs, [field, op, value]) {
            return docs.filter(d => {
                const v = d[field];
                if (op === '==') return v === value;
                if (op === '>=') return v >= value;
                if (op === '<=') return v <= value;
                if (op === '!=') return v !== value;
                return true;
            });
        }
        function sortDocs(docs, order) {
            if (!order) return docs;
            const sorted = docs.slice().sort((a, b) => {
                const av = a[order.field], bv = b[order.field];
                const cmp = av < bv ? -1 : av > bv ? 1 : 0;
                return order.dir === 'desc' ? -cmp : cmp;
            });
            return sorted;
        }

        function makeQuery(storeName, wheres, order) {
            return {
                where(field, op, value) { return makeQuery(storeName, wheres.concat([[field, op, value]]), order); },
                orderBy(field, dir) { return makeQuery(storeName, wheres, { field, dir: dir || 'asc' }); },
                limit(n) {
                    const base = this;
                    return Object.assign({}, base, {
                        async get() {
                            let docs = await idbGetAll(storeName);
                            wheres.forEach(w => { docs = applyWhere(docs, w); });
                            docs = sortDocs(docs, order).slice(0, n);
                            return makeSnapshot(docs);
                        }
                    });
                },
                async get() {
                    let docs = await idbGetAll(storeName);
                    wheres.forEach(w => { docs = applyWhere(docs, w); });
                    docs = sortDocs(docs, order);
                    return makeSnapshot(docs);
                }
            };
        }

        function collection(name) {
            return {
                doc(id) {
                    const docId = id || genId();
                    return {
                        id: docId,
                        async get() {
                            const data = await idbGetOne(name, docId);
                            return { exists: !!data, id: docId, data: () => data ? Object.assign({}, data) : undefined };
                        },
                        async set(obj) { await idbPut(name, Object.assign({}, obj, { id: docId })); },
                        async update(partial) {
                            const existing = (await idbGetOne(name, docId)) || {};
                            await idbPut(name, Object.assign({}, existing, partial, { id: docId }));
                        },
                        async delete() { await idbDelete(name, docId); }
                    };
                },
                async add(obj) {
                    const docId = genId();
                    await idbPut(name, Object.assign({}, obj, { id: docId }));
                    return { id: docId };
                },
                async get() { return makeSnapshot(await idbGetAll(name)); },
                where(field, op, value) { return makeQuery(name, [[field, op, value]]); },
                orderBy(field, dir) { return makeQuery(name, [], { field, dir: dir || 'asc' }); }
            };
        }

        const db = { collection };

        // =====================================================================
        // CONFIGURAÇÕES, SERVIÇOS E ESTADO
        // =====================================================================
        const APP_VERSION = '2.0.0';
        const CACHE_PREFIX = 'barbearia-imperial';
        const BACKUP_ID = 'barbearia-imperial';
        const APP_FILES = ['index.html', 'style.css', 'app.js', 'manifest.json', 'logo.webp'];

        let CONFIG = {
            barberName: 'João',
            openHour: 8,
            closeHour: 22,
            closedDays: [0, 1], // 0 = Domingo, 1 = Segunda (aberto Terça a Sábado)
            theme: 'light',
            lastBackup: null
        };

        // Contagem de serviços: corte = 1, barba = 1, corte + barba = 2
        const SERVICES = {
            'corte':       { label: 'Corte (30 min)',     cortes: 1, barbas: 0 },
            'barba':       { label: 'Barba (30 min)',     cortes: 0, barbas: 1 },
            'corte-barba': { label: 'Corte + Barba (1h)', cortes: 1, barbas: 1 }
        };

        const STATUS_META = {
            pendente: { label: 'A Confirmar' },
            confirmado: { label: 'Confirmado' },
            finalizado: { label: 'Finalizado' },
            cancelado: { label: 'Cancelado' }
        };

        const ICON_TRASH = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 20 7"/><path d="M6 7V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v3"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

        const ICON_EDIT = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';

        let agendaMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        let servicesMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        let selectedAgendaDate = new Date();
        let allClientsCache = [];
        let clientStats = {};

        // =====================================================================
        // UTILITÁRIOS
        // =====================================================================
        function pad(n) { return String(n).padStart(2, '0'); }
        function toDateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
        function todayStr() { return toDateStr(new Date()); }

        function formatDateBR(dateStr) {
            if (!dateStr) return '—';
            return new Date(dateStr + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
        }

        function formatDateLong(dateStr) {
            const s = new Date(dateStr + 'T00:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
            return s.charAt(0).toUpperCase() + s.slice(1);
        }

        function serviceInfo(key) { return SERVICES[key] || { label: key || 'Serviço', cortes: 0, barbas: 0 }; }
        function serviceLabel(key) { return serviceInfo(key).label; }
        function serviceUnits(key) { const s = serviceInfo(key); return s.cortes + s.barbas; }
        function serviceOptions(selected) {
            return Object.keys(SERVICES).map(k => `<option value="${k}" ${k === selected ? 'selected' : ''}>${SERVICES[k].label}</option>`).join('');
        }
        function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

        function dayWord(dateStr) {
            const now = new Date();
            if (dateStr === toDateStr(now)) return 'hoje';
            if (dateStr === toDateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))) return 'amanhã';
            return 'no dia ' + dateStr.slice(8, 10) + '/' + dateStr.slice(5, 7);
        }

        function toWhatsAppLink(phone, message) {
            let digits = (phone || '').replace(/\D/g, '');
            if (digits && digits.length <= 11) digits = '55' + digits;
            return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
        }

        function withTimeout(promise, ms) {
            return Promise.race([
                promise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('Tempo de espera esgotado.')), ms || 10000))
            ]);
        }

        function showToast(msg, type) {
            type = type || 'success';
            const t = document.getElementById('toast');
            t.textContent = msg;
            t.className = 'toast show ' + type;
            clearTimeout(window.__toastTimer);
            window.__toastTimer = setTimeout(() => { t.className = 'toast ' + type; }, 3500);
        }

        // =====================================================================
        // MODAL
        // =====================================================================
        function openModal(title, bodyHtml) {
            document.getElementById('modalTitle').textContent = title;
            document.getElementById('modalBody').innerHTML = bodyHtml;
            document.getElementById('modalOverlay').style.display = 'flex';
        }
        function closeModal() {
            document.getElementById('modalOverlay').style.display = 'none';
        }

        // =====================================================================
        // NAVEGAÇÃO / ABAS
        // =====================================================================
        const TAB_TITLES = { agenda: 'Agenda Digital', clientes: 'Base de Clientes', servicos: 'Serviços Realizados' };

        function switchTab(tabId, element) {
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
            document.getElementById(tabId).classList.add('active');
            (element || document.getElementById('nav-' + tabId)).classList.add('active');
            document.getElementById('page-title').textContent = TAB_TITLES[tabId];
            closeSidebar();

            if (tabId === 'agenda') { renderAgendaCalendar(); renderAgendaTimeline(); }
            else if (tabId === 'clientes') loadClients();
            else if (tabId === 'servicos') loadServicesTab();
        }

        function goToTab(tabId) { switchTab(tabId, document.getElementById('nav-' + tabId)); }

        function toggleSidebar() {
            document.getElementById('sidebar').classList.toggle('open');
            document.getElementById('sidebarBackdrop').classList.toggle('open');
        }
        function closeSidebar() {
            document.getElementById('sidebar').classList.remove('open');
            document.getElementById('sidebarBackdrop').classList.remove('open');
        }

        // =====================================================================
        // CONFIGURAÇÕES (tema, horário, backup e atualização do app)
        // =====================================================================
        function applyTheme(theme) {
            if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
            else document.documentElement.removeAttribute('data-theme');
        }

        function updateBarberLabel() {
            document.getElementById('barberNameLabel').textContent = CONFIG.barberName;
        }

        async function saveConfig() {
            await db.collection('settings').doc('config').set(CONFIG);
        }

        async function loadSettings() {
            try {
                const doc = await db.collection('settings').doc('config').get();
                if (doc.exists) {
                    const saved = doc.data();
                    Object.keys(CONFIG).forEach(k => { if (saved[k] !== undefined) CONFIG[k] = saved[k]; });
                } else {
                    await saveConfig();
                }
            } catch (e) {
                console.error('Erro ao carregar configurações:', e);
            }
            updateBarberLabel();
            applyTheme(CONFIG.theme);
        }

        async function selectThemeOption(theme) {
            CONFIG.theme = theme;
            applyTheme(theme);
            document.getElementById('themeLightBtn').className = 'btn' + (theme === 'light' ? '' : ' btn-outline');
            document.getElementById('themeDarkBtn').className = 'btn' + (theme === 'dark' ? '' : ' btn-outline');
            try { await saveConfig(); } catch (e) { console.error(e); }
        }

        function lastBackupText() {
            return CONFIG.lastBackup ? 'Último backup: ' + new Date(CONFIG.lastBackup).toLocaleString('pt-BR') : 'Você ainda não fez nenhum backup.';
        }

        function openSettingsModal() {
            openModal('Configurações', `
                <div class="form-group">
                    <label>Aparência</label>
                    <div class="form-row">
                        <button type="button" id="themeLightBtn" class="btn${CONFIG.theme === 'dark' ? ' btn-outline' : ''}" onclick="selectThemeOption('light')">☀️ Claro</button>
                        <button type="button" id="themeDarkBtn" class="btn${CONFIG.theme === 'dark' ? '' : ' btn-outline'}" onclick="selectThemeOption('dark')">🌙 Escuro</button>
                    </div>
                </div>
                <div class="form-group">
                    <label>Nome do Barbeiro</label>
                    <input id="cfgBarberName" value="${CONFIG.barberName}">
                </div>
                <div class="form-row">
                    <div class="form-group"><label>Abertura (hora)</label><input type="number" id="cfgOpenHour" value="${CONFIG.openHour}" min="0" max="23"></div>
                    <div class="form-group"><label>Fechamento (hora)</label><input type="number" id="cfgCloseHour" value="${CONFIG.closeHour}" min="1" max="24"></div>
                </div>
                <p class="helper-text">A barbearia fecha domingo e segunda por padrão (terça a sábado); pra mudar, edite <code>closedDays</code> no <code>app.js</code>.</p>
                <button class="btn btn-block" onclick="saveSettings()">Salvar Configurações</button>

                <div class="modal-section">
                    <h4>Backup dos dados</h4>
                    <p class="helper-text" id="lastBackupLabel">${lastBackupText()}</p>
                    <p class="helper-text">Os dados ficam só neste aparelho. Exporte de vez em quando e guarde o arquivo no Drive ou no WhatsApp.</p>
                    <div class="form-row">
                        <button class="btn btn-outline" onclick="exportBackup()">Exportar backup</button>
                        <button class="btn btn-outline" onclick="document.getElementById('importFileInput').click()">Importar backup</button>
                    </div>
                    <input type="file" id="importFileInput" accept=".json,application/json" hidden onchange="onImportFileChosen(this)">
                </div>

                <div class="modal-section">
                    <h4>Aplicativo</h4>
                    <p class="helper-text">Versão ${APP_VERSION}</p>
                    <button class="btn btn-outline btn-block" onclick="forceUpdateApp()">Forçar atualização do app</button>
                </div>
            `);
        }

        async function saveSettings() {
            const openHour = parseInt(document.getElementById('cfgOpenHour').value);
            const closeHour = parseInt(document.getElementById('cfgCloseHour').value);
            if (isNaN(openHour) || isNaN(closeHour) || closeHour <= openHour) {
                showToast('O fechamento precisa ser depois da abertura', 'error');
                return;
            }
            CONFIG.barberName = document.getElementById('cfgBarberName').value.trim() || 'João';
            CONFIG.openHour = openHour;
            CONFIG.closeHour = closeHour;
            try {
                await saveConfig();
                updateBarberLabel();
                showToast('Configurações salvas!');
                closeModal();
                renderAgendaTimeline();
            } catch (e) {
                showToast('Erro ao salvar configurações', 'error');
            }
        }

        // ---------- Backup (exportar / importar) ----------
        function downloadTextFile(filename, text, mime) {
            const url = URL.createObjectURL(new Blob([text], { type: mime }));
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        }

        async function exportBackup() {
            try {
                CONFIG.lastBackup = new Date().toISOString();
                await saveConfig();
                const data = {};
                for (const store of IDB_STORES) data[store] = await idbGetAll(store);
                const payload = { app: BACKUP_ID, appVersion: APP_VERSION, exportedAt: CONFIG.lastBackup, data };
                downloadTextFile(`backup-barbearia-imperial-${todayStr()}.json`, JSON.stringify(payload), 'application/json');
                const label = document.getElementById('lastBackupLabel');
                if (label) label.textContent = lastBackupText();
                showToast('Backup exportado! Guarde o arquivo em um lugar seguro.');
            } catch (e) {
                console.error(e);
                showToast('Erro ao exportar o backup', 'error');
            }
        }

        function parseBackup(text) {
            let payload;
            try { payload = JSON.parse(text); } catch (e) { throw new Error('Arquivo ilegível: não é um backup válido.'); }
            if (!payload || payload.app !== BACKUP_ID || !payload.data || typeof payload.data !== 'object') {
                throw new Error('Esse arquivo não é um backup da Barbearia Imperial.');
            }
            IDB_STORES.forEach(store => {
                const rows = payload.data[store];
                if (!Array.isArray(rows)) throw new Error('Backup incompleto: falta "' + store + '".');
                rows.forEach(r => {
                    if (!r || typeof r.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(r.id)) throw new Error('Backup com registro inválido em "' + store + '".');
                });
            });
            return payload;
        }

        async function restoreBackup(payload) {
            const idb = await idbPromise;
            await new Promise((resolve, reject) => {
                const tx = idb.transaction(IDB_STORES, 'readwrite');
                IDB_STORES.forEach(store => {
                    const os = tx.objectStore(store);
                    os.clear();
                    payload.data[store].forEach(row => os.put(row));
                });
                tx.oncomplete = () => resolve();
                tx.onerror = tx.onabort = () => reject(tx.error || new Error('Falha ao restaurar'));
            });
        }

        async function onImportFileChosen(input) {
            const file = input.files && input.files[0];
            input.value = '';
            if (!file) return;
            try {
                const payload = parseBackup(await file.text());
                const when = payload.exportedAt ? new Date(payload.exportedAt).toLocaleString('pt-BR') : 'data desconhecida';
                const msg = `Restaurar o backup de ${when}?\n\n${payload.data.bookings.length} agendamento(s) e ${payload.data.clients.length} cliente(s).\n\nISSO SUBSTITUI todos os dados atuais deste aparelho.`;
                if (!confirm(msg)) return;
                await restoreBackup(payload);
                showToast('Backup restaurado! Recarregando...');
                setTimeout(() => location.reload(), 900);
            } catch (e) {
                console.error(e);
                showToast(e.message || 'Erro ao importar o backup', 'error');
            }
        }

        // ---------- Atualização do app ----------
        async function forceUpdateApp() {
            if (!confirm('Baixar a versão mais recente do aplicativo agora? Seus dados não serão apagados.')) return;
            try {
                const probe = await fetch('index.html', { cache: 'reload' });
                if (!probe.ok) throw new Error('HTTP ' + probe.status);
            } catch (e) {
                showToast('Não foi possível baixar a atualização (sem internet?). Nada foi alterado.', 'error');
                return;
            }
            try {
                if ('serviceWorker' in navigator) {
                    const regs = await navigator.serviceWorker.getRegistrations();
                    await Promise.all(regs.map(r => r.unregister()));
                }
                if (window.caches) {
                    const keys = await caches.keys();
                    await Promise.all(keys.filter(k => k.startsWith(CACHE_PREFIX)).map(k => caches.delete(k)));
                }
                await Promise.all(APP_FILES.map(f => fetch(f, { cache: 'reload' }).catch(() => null)));
            } catch (e) {
                console.error(e);
            }
            location.reload();
        }

        // =====================================================================
        // CLIENTES
        // =====================================================================
        async function refreshClientsCache() {
            try {
                const snap = await db.collection('clients').orderBy('name').get();
                allClientsCache = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
            } catch (e) {
                console.error(e);
                allClientsCache = [];
            }
        }

        async function computeClientStats() {
            const stats = {};
            try {
                const snap = await db.collection('bookings').where('status', '==', 'finalizado').get();
                snap.forEach(doc => {
                    const b = doc.data();
                    if (!b.clientId) return;
                    const s = stats[b.clientId] || (stats[b.clientId] = { services: 0, lastVisit: '' });
                    s.services += serviceUnits(b.service);
                    if (b.date > s.lastVisit) s.lastVisit = b.date;
                });
            } catch (e) { console.error(e); }
            return stats;
        }

        async function loadClients() {
            document.getElementById('clientsTableBody').innerHTML = `<tr><td colspan="5" class="loading-row"><div class="spinner-gold"></div>Carregando...</td></tr>`;
            await refreshClientsCache();
            clientStats = await computeClientStats();
            renderClientsTable();
        }

        function renderClientsTable() {
            const filter = (document.getElementById('clientSearchInput').value || '').toLowerCase();
            const filtered = allClientsCache.filter(c =>
                c.name.toLowerCase().includes(filter) || (c.phone || '').includes(filter)
            );

            if (filtered.length === 0) {
                document.getElementById('clientsTableBody').innerHTML = `<tr><td colspan="5" style="text-align:center; padding:30px; color:var(--text-gray);">Nenhum cliente encontrado</td></tr>`;
                return;
            }

            let html = '';
            filtered.forEach(c => {
                const st = clientStats[c.id] || { services: 0, lastVisit: '' };
                html += `<tr>
                    <td><strong>${c.name}</strong></td>
                    <td>${c.phone || '—'}</td>
                    <td>${formatDateBR(st.lastVisit)}</td>
                    <td>${st.services}</td>
                    <td>
                        <button class="btn-icon edit" onclick="openEditClientModal('${c.id}')" title="Editar">${ICON_EDIT}</button>
                        <button class="btn-icon danger" onclick="deleteClient('${c.id}')" title="Excluir">${ICON_TRASH}</button>
                    </td>
                </tr>`;
            });
            document.getElementById('clientsTableBody').innerHTML = html;
        }

        function openNewClientModal() {
            openModal('Novo Cliente', `
                <div class="form-group"><label>Nome Completo</label><input id="ncName" placeholder="Nome do cliente"></div>
                <div class="form-group"><label>WhatsApp</label><input id="ncPhone" placeholder="(11) 99999-9999"></div>
                <div class="form-group"><label>Email (opcional)</label><input id="ncEmail" type="email" placeholder="cliente@email.com"></div>
                <button class="btn btn-block" onclick="submitNewClient()">Cadastrar Cliente</button>
            `);
        }

        async function submitNewClient() {
            const name = document.getElementById('ncName').value.trim();
            const phone = document.getElementById('ncPhone').value.trim();
            const email = document.getElementById('ncEmail').value.trim();

            if (!name || !phone) { showToast('Preencha nome e WhatsApp', 'error'); return; }

            try {
                await db.collection('clients').add({
                    name, phone, email, createdAt: todayStr()
                });
                showToast('Cliente cadastrado!');
                closeModal();
                loadClients();
            } catch (e) { showToast('Erro ao cadastrar cliente', 'error'); }
        }

        function openEditClientModal(id) {
            const c = allClientsCache.find(x => x.id === id);
            if (!c) return;
            openModal('Editar Cliente', `
                <div class="form-group"><label>Nome Completo</label><input id="ecName" value="${c.name}"></div>
                <div class="form-group"><label>WhatsApp</label><input id="ecPhone" value="${c.phone || ''}"></div>
                <div class="form-group"><label>Email</label><input id="ecEmail" type="email" value="${c.email || ''}"></div>
                <button class="btn btn-block" onclick="submitEditClient('${id}')">Salvar Alterações</button>
            `);
        }

        async function submitEditClient(id) {
            const name = document.getElementById('ecName').value.trim();
            const phone = document.getElementById('ecPhone').value.trim();
            const email = document.getElementById('ecEmail').value.trim();

            if (!name || !phone) { showToast('Preencha nome e WhatsApp', 'error'); return; }

            try {
                await db.collection('clients').doc(id).update({ name, phone, email });
                showToast('Cliente atualizado!');
                closeModal();
                loadClients();
            } catch (e) { showToast('Erro ao atualizar cliente', 'error'); }
        }

        async function deleteClient(id) {
            if (!confirm('Excluir este cliente? Os agendamentos dele continuam na agenda.')) return;
            try {
                await db.collection('clients').doc(id).delete();
                showToast('Cliente excluído');
                loadClients();
            } catch (e) { showToast('Erro ao excluir', 'error'); }
        }

        // =====================================================================
        // AGENDA — calendário do mês
        // =====================================================================
        function changeAgendaMonth(delta) {
            agendaMonth = new Date(agendaMonth.getFullYear(), agendaMonth.getMonth() + delta, 1);
            renderAgendaCalendar();
        }

        async function renderAgendaCalendar() {
            const year = agendaMonth.getFullYear();
            const month = agendaMonth.getMonth();
            const label = agendaMonth.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
            document.getElementById('agendaMonthLabel').textContent = label.charAt(0).toUpperCase() + label.slice(1);

            const firstDay = new Date(year, month, 1);
            const lastDay = new Date(year, month + 1, 0);
            const daysInMonth = lastDay.getDate();
            const startWeekday = firstDay.getDay();

            let countsByDate = {};
            try {
                const startStr = toDateStr(firstDay);
                const endStr = toDateStr(lastDay);
                // filtro único por range de data (sem exigir índice composto) — filtra status no cliente
                const snap = await db.collection('bookings').where('date', '>=', startStr).where('date', '<=', endStr).get();
                snap.forEach(doc => {
                    const b = doc.data();
                    if (b.status === 'pendente' || b.status === 'confirmado' || b.status === 'finalizado') {
                        countsByDate[b.date] = (countsByDate[b.date] || 0) + 1;
                    }
                });
            } catch (e) {
                console.error(e);
            }

            let html = '';
            ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].forEach(d => {
                html += `<div class="cal-day-header">${d}</div>`;
            });
            for (let i = 0; i < startWeekday; i++) {
                html += `<div class="cal-cell empty"></div>`;
            }
            for (let day = 1; day <= daysInMonth; day++) {
                const date = new Date(year, month, day);
                const dateStr = toDateStr(date);
                const isClosed = CONFIG.closedDays.includes(date.getDay());
                const isSelected = toDateStr(selectedAgendaDate) === dateStr;
                const hasBookings = countsByDate[dateStr] > 0;
                const classes = ['cal-cell', isClosed && 'closed', isSelected && 'selected'].filter(Boolean).join(' ');
                html += `<div class="${classes}" onclick="selectAgendaDay('${dateStr}')">
                    ${day}${hasBookings ? '<span class="cal-dot"></span>' : ''}
                </div>`;
            }
            document.getElementById('agendaCalendarGrid').innerHTML = html;
        }

        function selectAgendaDay(dateStr) {
            selectedAgendaDate = new Date(dateStr + 'T00:00:00');
            renderAgendaCalendar();
            renderAgendaTimeline();
        }

        // =====================================================================
        // AGENDA — timeline do dia (linha do tempo colorida por status)
        // vermelho = disponível | dourado = a confirmar | azul = confirmado | verde = finalizado
        // =====================================================================
        async function renderAgendaTimeline() {
            const dateStr = toDateStr(selectedAgendaDate);
            document.getElementById('agendaDayTitle').textContent = formatDateLong(dateStr);
            const el = document.getElementById('agendaTimeline');
            if (CONFIG.closedDays.includes(selectedAgendaDate.getDay())) {
                el.innerHTML = `<div class="empty-state">A barbearia não abre neste dia.</div>`;
                return;
            }
            el.innerHTML = `<div class="loading-row"><div class="spinner-gold"></div>Carregando...</div>`;

            try {
                const snap = await db.collection('bookings').where('date', '==', dateStr).get();
                const byTime = {};
                snap.forEach(doc => {
                    const b = Object.assign({ id: doc.id }, doc.data());
                    if (b.status === 'cancelado') return; // libera o horário de volta
                    byTime[b.time] = b;
                });

                let html = '';
                for (let h = CONFIG.openHour; h < CONFIG.closeHour; h++) {
                    const t = pad(h) + ':00';
                    const b = byTime[t];
                    if (!b) {
                        html += `<div class="slot-row" onclick="openSlotModal('${dateStr}','${t}')">
                            <span class="slot-time">${t}</span>
                            <div class="slot-info"><div class="slot-client">Disponível</div></div>
                            <span class="status disponivel">Livre</span>
                        </div>`;
                    } else {
                        const meta = STATUS_META[b.status] || STATUS_META.pendente;
                        html += `<div class="slot-row ${b.status}" onclick="openSlotModal('${dateStr}','${t}')">
                            <span class="slot-time">${t}</span>
                            <div class="slot-info">
                                <div class="slot-client">${b.clientName}</div>
                                <div class="slot-detail">${serviceLabel(b.service)}</div>
                            </div>
                            <span class="status ${b.status}">${meta.label}</span>
                        </div>`;
                    }
                }
                el.innerHTML = html;
            } catch (e) {
                console.error(e);
                el.innerHTML = `<div class="empty-state">Erro ao carregar a agenda deste dia</div>`;
            }
        }

        async function openSlotModal(dateStr, time) {
            openModal(time, `<div class="loading-row"><div class="spinner-gold"></div>Carregando horário...</div>`);
            try {
                const snap = await withTimeout(db.collection('bookings').where('date', '==', dateStr).get());
                let booking = null;
                snap.forEach(doc => {
                    const b = doc.data();
                    if (b.time === time && b.status !== 'cancelado') booking = Object.assign({ id: doc.id }, b);
                });

                if (!booking) { await openCreateBookingModal(dateStr, time); return; }
                if (booking.status === 'finalizado') { await openBookingHistoryModal(booking); return; }
                await openEditBookingModal(booking);
            } catch (e) {
                console.error(e);
                closeModal();
                showToast(e.message || 'Erro ao abrir horário', 'error');
            }
        }

        // =====================================================================
        // AGENDA — criar novo agendamento
        // =====================================================================
        async function openNewBookingModal() {
            const dateStr = toDateStr(selectedAgendaDate);
            await openCreateBookingModal(dateStr, null);
        }

        async function openCreateBookingModal(dateStr, presetTime) {
            const isClosed = CONFIG.closedDays.includes(new Date(dateStr + 'T00:00:00').getDay());
            if (isClosed) { showToast('A barbearia está fechada neste dia', 'error'); return; }

            openModal(`Novo Agendamento — ${formatDateBR(dateStr)}`, `<div class="loading-row"><div class="spinner-gold"></div>Carregando...</div>`);

            try {
                if (allClientsCache.length === 0) await withTimeout(refreshClientsCache());

                let timeFieldHtml = '';
                if (presetTime) {
                    timeFieldHtml = `<input type="hidden" id="nbTime" value="${presetTime}">
                        <div class="form-group"><label>Horário</label><input value="${presetTime}" disabled style="background:var(--card-bg);"></div>`;
                } else {
                    let booked = [];
                    try {
                        const snap = await withTimeout(db.collection('bookings').where('date', '==', dateStr).get());
                        booked = snap.docs.map(d => d.data()).filter(b => b.status !== 'cancelado').map(b => b.time);
                    } catch (e) {}
                    let opts = '';
                    for (let h = CONFIG.openHour; h < CONFIG.closeHour; h++) {
                        const t = pad(h) + ':00';
                        if (!booked.includes(t)) opts += `<option value="${t}">${t}</option>`;
                    }
                    if (!opts) { closeModal(); showToast('Não há horários livres neste dia', 'error'); return; }
                    timeFieldHtml = `<div class="form-group"><label>Horário</label><select id="nbTime">${opts}</select></div>`;
                }

                const clientOptions = allClientsCache.map(c => `<option value="${c.id}">${c.name} — ${c.phone}</option>`).join('');
                openModal(`Novo Agendamento — ${formatDateBR(dateStr)}`, `
                    <div class="form-group">
                        <label>Cliente</label>
                        <select id="nbClientSelect" onchange="document.getElementById('nbNewClientFields').style.display = this.value==='__new__' ? 'block':'none';">
                            <option value="__new__">+ Cliente novo</option>
                            ${clientOptions}
                        </select>
                    </div>
                    <div id="nbNewClientFields">
                        <div class="form-group"><label>Nome</label><input id="nbClientName" placeholder="Nome do cliente"></div>
                        <div class="form-group"><label>WhatsApp</label><input id="nbClientPhone" placeholder="(11) 99999-9999"></div>
                    </div>
                    <div class="form-group">
                        <label>Serviço</label>
                    <select id="nbService">${serviceOptions('corte')}</select>
                </div>
                ${timeFieldHtml}
                <input type="hidden" id="nbDate" value="${dateStr}">
                <button class="btn btn-block" onclick="submitNewBooking()">Confirmar Agendamento</button>
            `);
            } catch (e) {
                console.error(e);
                closeModal();
                showToast(e.message || 'Erro ao abrir novo agendamento', 'error');
            }
        }

        async function submitNewBooking() {
            const dateStr = document.getElementById('nbDate').value;
            const time = document.getElementById('nbTime').value;
            const service = document.getElementById('nbService').value;
            const clientSelectVal = document.getElementById('nbClientSelect').value;

            try {
                let clientId, clientName, clientPhone;
                if (clientSelectVal === '__new__') {
                    clientName = document.getElementById('nbClientName').value.trim();
                    clientPhone = document.getElementById('nbClientPhone').value.trim();
                    if (!clientName || !clientPhone) { showToast('Preencha nome e WhatsApp do cliente', 'error'); return; }
                    const ref = db.collection('clients').doc();
                    await ref.set({ name: clientName, phone: clientPhone, email: '', createdAt: todayStr() });
                    clientId = ref.id;
                } else {
                    const c = allClientsCache.find(c => c.id === clientSelectVal);
                    if (!c) { showToast('Cliente não encontrado', 'error'); return; }
                    clientId = c.id; clientName = c.name; clientPhone = c.phone;
                }

                await db.collection('bookings').add({
                    clientId, clientName, clientPhone, service, barber: CONFIG.barberName,
                    date: dateStr, time, status: 'pendente', createdAt: new Date().toISOString()
                });

                showToast('Agendamento criado!');
                closeModal();
                await refreshClientsCache();
                selectedAgendaDate = new Date(dateStr + 'T00:00:00');
                renderAgendaCalendar();
                renderAgendaTimeline();
            } catch (e) {
                console.error(e);
                showToast('Erro ao criar agendamento', 'error');
            }
        }

        // =====================================================================
        // AGENDA — editar / confirmar / cancelar / excluir agendamento
        // =====================================================================
        async function openEditBookingModal(booking) {
            if (allClientsCache.length === 0) await withTimeout(refreshClientsCache());
            const clientOptions = allClientsCache.map(c => `<option value="${c.id}" ${c.id === booking.clientId ? 'selected' : ''}>${c.name} — ${c.phone}</option>`).join('');
            const meta = STATUS_META[booking.status];

            openModal(`${booking.time} — ${booking.clientName}`, `
                <p class="helper-text">Status atual: <span class="status ${booking.status}">${meta.label}</span></p>
                <div class="form-group">
                    <label>Cliente</label>
                    <select id="ebClientSelect">${clientOptions}</select>
                </div>
                <div class="form-group">
                    <label>Serviço</label>
                    <select id="ebService">${serviceOptions(booking.service)}</select>
                </div>
                <button class="btn btn-block" onclick="saveEditedBooking('${booking.id}')">Salvar Alterações</button>
                <button class="btn btn-success btn-block" style="margin-top:12px;" onclick="finalizeBooking('${booking.id}')">Finalizar atendimento</button>
                ${booking.status === 'pendente' ? `<button class="btn btn-outline btn-block" onclick="setBookingStatus('${booking.id}','confirmado')">Confirmar agendamento</button>` : ''}
                <div class="form-row" style="margin-top:8px;">
                    <button class="btn btn-outline" onclick="setBookingStatus('${booking.id}','cancelado')">Cancelar Horário</button>
                    <button class="btn btn-danger" onclick="deleteBookingV2('${booking.id}')">Excluir</button>
                </div>
            `);
        }

        async function saveEditedBooking(id) {
            const clientSel = document.getElementById('ebClientSelect').value;
            const service = document.getElementById('ebService').value;
            const c = allClientsCache.find(c => c.id === clientSel);
            if (!c) { showToast('Cliente inválido', 'error'); return; }
            try {
                await db.collection('bookings').doc(id).update({ clientId: c.id, clientName: c.name, clientPhone: c.phone, service });
                showToast('Agendamento atualizado!');
                closeModal();
                renderAgendaTimeline();
                renderAgendaCalendar();
            } catch (e) { showToast('Erro ao salvar', 'error'); }
        }

        async function setBookingStatus(id, status) {
            try {
                await db.collection('bookings').doc(id).update({ status });
                showToast(status === 'confirmado' ? 'Agendamento confirmado!' : 'Horário liberado');
                closeModal();
                renderAgendaTimeline();
                renderAgendaCalendar();
            } catch (e) { showToast('Erro ao atualizar status', 'error'); }
        }

        async function deleteBookingV2(id) {
            if (!confirm('Excluir este agendamento definitivamente?')) return;
            try {
                await db.collection('bookings').doc(id).delete();
                showToast('Agendamento excluído');
                closeModal();
                renderAgendaTimeline();
                renderAgendaCalendar();
            } catch (e) { showToast('Erro ao excluir', 'error'); }
        }


        // =====================================================================
        // AGENDA — histórico (o que o cliente consumiu, quando finalizado)
        // =====================================================================
        async function openBookingHistoryModal(booking) {
            const s = serviceInfo(booking.service);
            openModal(`Finalizado — ${booking.clientName}`, `
                <p class="helper-text">${formatDateLong(booking.date)} às ${booking.time}</p>
                <div class="receipt-box">
                    <div class="simple-list-item"><span class="name">${s.label}</span><span class="amount">${plural(s.cortes + s.barbas, 'serviço', 'serviços')}</span></div>
                </div>
                <div class="form-row">
                    <button class="btn btn-outline" onclick="setBookingStatus('${booking.id}','confirmado')">Reabrir</button>
                    <button class="btn btn-danger" onclick="deleteBookingV2('${booking.id}')">Excluir</button>
                </div>
            `);
        }

        async function finalizeBooking(id) {
            const c = allClientsCache.find(x => x.id === document.getElementById('ebClientSelect').value);
            const service = document.getElementById('ebService').value;
            try {
                const b = (await db.collection('bookings').doc(id).get()).data();
                if (b.date > todayStr() && !confirm('Esse horário é no futuro. Finalizar mesmo assim?')) return;
                const changes = { service, status: 'finalizado', finishedAt: new Date().toISOString() };
                if (c) Object.assign(changes, { clientId: c.id, clientName: c.name, clientPhone: c.phone });
                await db.collection('bookings').doc(id).update(changes);
                showToast('Atendimento finalizado — ' + plural(serviceUnits(service), 'serviço contabilizado', 'serviços contabilizados'));
                closeModal();
                renderAgendaTimeline();
                renderAgendaCalendar();
            } catch (e) { console.error(e); showToast('Erro ao finalizar o atendimento', 'error'); }
        }

        // =====================================================================
        // AGENDA — confirmar via WhatsApp (abre a conversa pronta, um por vez)
        // =====================================================================
        async function openWhatsAppConfirmModal() {
            const dateStr = toDateStr(selectedAgendaDate);
            openModal('Confirmar via WhatsApp — ' + formatDateBR(dateStr), `<div class="loading-row"><div class="spinner-gold"></div>Carregando...</div>`);
            try {
                const snap = await db.collection('bookings').where('date', '==', dateStr).get();
                const list = snap.docs.map(d => Object.assign({ id: d.id }, d.data()))
                    .filter(b => b.status === 'pendente' || b.status === 'confirmado')
                    .sort((a, b) => a.time.localeCompare(b.time));

                if (list.length === 0) {
                    document.getElementById('modalBody').innerHTML = '<p style="text-align:center; color:var(--text-gray); padding:20px;">Nenhum agendamento pra confirmar neste dia</p>';
                    return;
                }

                const rows = list.map(b => {
                    const msg = `Olá ${b.clientName}! Confirmando seu horário na Barbearia Imperial ${dayWord(b.date)} às ${b.time} (${serviceLabel(b.service)}). Te esperamos! 💈`;
                    const link = toWhatsAppLink(b.clientPhone, msg);
                    return `<div class="wa-list-item">
                        <div><strong>${b.time} — ${b.clientName}</strong><div class="slot-detail" style="color:var(--text-gray); font-size:0.8rem;">${serviceLabel(b.service)}</div></div>
                        <a href="${link}" target="_blank" rel="noopener" class="btn btn-whatsapp btn-small" style="text-decoration:none;" onclick="markConfirmedAfterSend('${b.id}')">Enviar</a>
                    </div>`;
                }).join('');

                document.getElementById('modalBody').innerHTML = `
                    <p class="helper-text">Cada botão abre o WhatsApp com a mensagem pronta — só apertar enviar. Não existe envio automático em massa sem a API paga do WhatsApp Business; isso aqui é o jeito mais rápido de mandar um por um.</p>
                    ${rows}
                `;
            } catch (e) {
                document.getElementById('modalBody').innerHTML = '<p style="text-align:center; padding:20px;">Erro ao carregar</p>';
            }
        }

        function markConfirmedAfterSend(bookingId) {
            db.collection('bookings').doc(bookingId).update({ status: 'confirmado' }).then(() => {
                renderAgendaTimeline();
                renderAgendaCalendar();
            }).catch(() => {});
        }

        // =====================================================================
        // SERVIÇOS REALIZADOS (contagem do dia e do mês)
        // Só contam atendimentos FINALIZADOS: corte = 1, barba = 1, corte + barba = 2
        // =====================================================================
        function tallyServices(list) {
            const t = { atendimentos: list.length, cortes: 0, barbas: 0 };
            list.forEach(b => { const s = serviceInfo(b.service); t.cortes += s.cortes; t.barbas += s.barbas; });
            t.total = t.cortes + t.barbas;
            return t;
        }

        function servicesDetail(t) {
            return `${plural(t.atendimentos, 'atendimento', 'atendimentos')} · ${plural(t.cortes, 'corte', 'cortes')} · ${plural(t.barbas, 'barba', 'barbas')}`;
        }

        function changeServicesMonth(delta) {
            servicesMonth = new Date(servicesMonth.getFullYear(), servicesMonth.getMonth() + delta, 1);
            loadServicesTab();
        }

        async function loadServicesTab() {
            const y = servicesMonth.getFullYear(), m = servicesMonth.getMonth();
            const first = toDateStr(new Date(y, m, 1)), last = toDateStr(new Date(y, m + 1, 0));
            const label = servicesMonth.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
            document.getElementById('servicesMonthLabel').textContent = label.charAt(0).toUpperCase() + label.slice(1);

            let done = [];
            try {
                const snap = await db.collection('bookings').where('status', '==', 'finalizado').get();
                done = snap.docs.map(d => d.data());
            } catch (e) {
                console.error(e);
                showToast('Erro ao carregar os serviços', 'error');
            }

            const hoje = tallyServices(done.filter(b => b.date === todayStr()));
            const month = done.filter(b => b.date >= first && b.date <= last);
            const mes = tallyServices(month);
            document.getElementById('servHojeTotal').textContent = hoje.total;
            document.getElementById('servHojeDetalhe').textContent = servicesDetail(hoje);
            document.getElementById('servMesTotal').textContent = mes.total;
            document.getElementById('servMesDetalhe').textContent = servicesDetail(mes);

            const byDay = {};
            month.forEach(b => { (byDay[b.date] = byDay[b.date] || []).push(b); });
            const days = Object.keys(byDay).sort().reverse();
            const body = document.getElementById('servicesDayBody');
            if (days.length === 0) {
                body.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:30px; color:var(--text-gray);">Nenhum atendimento finalizado neste mês. Finalize os atendimentos na Agenda pra eles contarem aqui.</td></tr>`;
                document.getElementById('servicesDayFoot').innerHTML = '';
                return;
            }
            body.innerHTML = days.map(d => {
                const t = tallyServices(byDay[d]);
                const dia = new Date(d + 'T00:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
                return `<tr><td>${dia}</td><td class="num">${t.atendimentos}</td><td class="num">${t.cortes}</td><td class="num">${t.barbas}</td><td class="num"><strong>${t.total}</strong></td></tr>`;
            }).join('');
            document.getElementById('servicesDayFoot').innerHTML =
                `<tr><td>Total do mês</td><td class="num">${mes.atendimentos}</td><td class="num">${mes.cortes}</td><td class="num">${mes.barbas}</td><td class="num">${mes.total}</td></tr>`;
        }

        // =====================================================================
        // ATALHOS DO ÍCONE (manifest.json → shortcuts: ?action=...)
        // =====================================================================
        function nextOpenDate() {
            const d = new Date();
            for (let i = 0; i < 7 && CONFIG.closedDays.includes(d.getDay()); i++) d.setDate(d.getDate() + 1);
            return d;
        }

        function handleLaunchAction() {
            const action = new URLSearchParams(location.search).get('action');
            if (!action) return;
            history.replaceState(null, '', location.pathname);
            if (action === 'new-booking') {
                selectedAgendaDate = nextOpenDate();
                agendaMonth = new Date(selectedAgendaDate.getFullYear(), selectedAgendaDate.getMonth(), 1);
                goToTab('agenda');
                openNewBookingModal();
            } else if (action === 'clients') goToTab('clientes');
            else if (action === 'services') goToTab('servicos');
        }

        // =====================================================================
        // INIT
        // =====================================================================
        async function initApp() {
            try { await idbPromise; } catch (e) { console.error(e); showToast('Não foi possível abrir o armazenamento local deste navegador.', 'error'); }
            await loadSettings();
            await refreshClientsCache();
            renderAgendaCalendar();
            renderAgendaTimeline();
            handleLaunchAction();

            if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
                navigator.serviceWorker.register('sw.js').catch(err => console.log('Service worker não registrado:', err.message));
            }
        }

        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initApp);
        else initApp();
