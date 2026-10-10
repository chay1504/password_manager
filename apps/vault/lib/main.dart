import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:tbd_core/tbd_core.dart';
import 'package:tbd_platform/tbd_platform.dart';

import 'vault_controller.dart';

const _ink = Color(0xff080808);
const _paper = Color(0xfff4f1ec);
const _red = Color(0xfff22d1c);

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const VaultApp());
}

class VaultApp extends StatelessWidget {
  const VaultApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'TBD Vault',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: _ink,
      fontFamily: 'Manrope',
      colorScheme: const ColorScheme.dark(
        primary: _red,
        surface: Color(0xff151515),
        onSurface: _paper,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: const Color(0xff1c1c1c),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(16),
          borderSide: BorderSide.none,
        ),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 18,
          vertical: 16,
        ),
      ),
    ),
    home: const VaultHome(),
  );
}

class VaultHome extends StatefulWidget {
  const VaultHome({super.key});

  @override
  State<VaultHome> createState() => _VaultHomeState();
}

class _VaultHomeState extends State<VaultHome> with WidgetsBindingObserver {
  final _vault = VaultController();
  final _clipboard = SecureClipboard();
  final _code = TextEditingController();
  final _search = TextEditingController();
  String? _selectedId;
  bool _editing = false;
  bool _showPassword = false;
  bool _obscured = false;
  DateTime? _backgroundedAt;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _vault.initialize();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _clipboard.clearIfStillCopied();
      if (_backgroundedAt != null &&
          DateTime.now().difference(_backgroundedAt!) >
              const Duration(minutes: 1)) {
        _vault.lock();
      }
      _backgroundedAt = null;
      if (mounted) setState(() => _obscured = false);
      return;
    }
    if (state == AppLifecycleState.inactive && Platform.isIOS) {
      if (mounted) setState(() => _obscured = true);
      return;
    }
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached) {
      _backgroundedAt ??= DateTime.now();
      if (_vault.phase == VaultPhase.open) {
        _vault.lock();
        _code.clear();
        _search.clear();
      }
      if (mounted) {
        setState(() {
          _obscured = true;
          _selectedId = null;
          _editing = false;
          _showPassword = false;
        });
      }
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _vault.dispose();
    _clipboard.dispose();
    _code.dispose();
    _search.dispose();
    super.dispose();
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  Future<String?> _askPassword({required bool confirm}) async {
    final password = TextEditingController();
    final again = TextEditingController();
    final answer = await showDialog<String>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: Text(confirm ? 'Create backup password' : 'Backup password'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              confirm
                  ? 'Use at least 12 characters. You will need this password and the backup file on a new phone.'
                  : 'Enter the separate password used when this backup was created.',
            ),
            const SizedBox(height: 15),
            TextField(
              controller: password,
              obscureText: true,
              decoration: const InputDecoration(labelText: 'Backup password'),
            ),
            if (confirm) ...[
              const SizedBox(height: 10),
              TextField(
                controller: again,
                obscureText: true,
                decoration: const InputDecoration(
                  labelText: 'Confirm password',
                ),
              ),
            ],
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialog),
            child: const Text('CANCEL'),
          ),
          FilledButton(
            onPressed: () {
              if (password.text.length < 12 ||
                  (confirm && password.text != again.text)) {
                ScaffoldMessenger.of(dialog).showSnackBar(
                  const SnackBar(
                    content: Text('Use at least 12 matching characters.'),
                  ),
                );
                return;
              }
              Navigator.pop(dialog, password.text);
            },
            child: const Text('CONTINUE'),
          ),
        ],
      ),
    );
    password.dispose();
    again.dispose();
    return answer;
  }

  Future<void> _export() async {
    final password = await _askPassword(confirm: true);
    if (password == null) return;
    try {
      final saved = await _vault.exportBackup(password);
      _toast(
        saved
            ? 'Backup verified. Keep the file and password in separate safe places.'
            : 'Backup was not saved. Please try again.',
      );
    } catch (_) {
      _toast('Could not create backup. Your vault was not changed.');
    }
  }

  Future<void> _import() async {
    if (_vault.phase != VaultPhase.setup) {
      final replace = await showDialog<bool>(
        context: context,
        builder: (dialog) => AlertDialog(
          title: const Text('Replace this vault?'),
          content: const Text(
            'Importing will replace every password currently saved on this phone.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialog, false),
              child: const Text('CANCEL'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialog, true),
              child: const Text('REPLACE'),
            ),
          ],
        ),
      );
      if (replace != true) return;
    }
    final password = await _askPassword(confirm: false);
    if (password == null) return;
    try {
      final imported = await _vault.importBackup(password);
      if (imported) {
        _code.clear();
        _toast('Backup restored. Pair TBD Codes and enter its new code.');
      }
    } catch (_) {
      _toast('Could not restore. Check the backup file and its password.');
    }
  }

  Future<void> _testBackup() async {
    final password = await _askPassword(confirm: false);
    if (password == null) return;
    try {
      final count = await _vault.testBackup(password);
      if (count != null) {
        _toast(
          'Backup opened successfully: $count saved accounts. Your vault was not changed.',
        );
      }
    } catch (_) {
      _toast('Backup test failed. Check the file and password.');
    }
  }

  Future<void> _verify() async {
    final success = await _vault.verifyCode(_code.text.trim());
    _code.clear();
    await _clipboard.clearIfCodeShaped();
    if (success) setState(() => _selectedId = null);
  }

  Future<void> _copy(String value, String label) async {
    await _clipboard.copy(value, expiry: const Duration(seconds: 20));
    _toast('$label copied. It is cleared from the clipboard after 20 seconds.');
  }

  Future<void> _delete(VaultEntry entry) async {
    final approved = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: const Text('Delete password?'),
        content: Text('Remove ${entry.name} from this phone?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialog, false),
            child: const Text('CANCEL'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialog, true),
            child: const Text('DELETE'),
          ),
        ],
      ),
    );
    if (approved != true) return;
    try {
      await _vault.deleteEntry(entry.id);
      setState(() => _selectedId = null);
    } catch (_) {
      _toast('Could not delete this password.');
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _vault,
    builder: (context, _) => Scaffold(
      appBar: AppBar(
        backgroundColor: _ink,
        title: const Text(
          'TBD VAULT',
          style: TextStyle(
            fontFamily: 'Bebas Neue',
            fontSize: 29,
            letterSpacing: 1.5,
          ),
        ),
        actions: [
          if (_vault.phase == VaultPhase.open) ...[
            IconButton(
              tooltip: 'Add account',
              onPressed: () {
                if (_vault.data!.lastBackupRevision < 0) {
                  _toast('Create your first backup before adding passwords.');
                  return;
                }
                setState(() {
                  _selectedId = null;
                  _editing = true;
                });
              },
              icon: const Icon(Icons.add),
            ),
            PopupMenuButton<String>(
              tooltip: 'Backup options',
              onSelected: (value) {
                if (value == 'export') {
                  _export();
                } else if (value == 'test') {
                  _testBackup();
                } else {
                  _import();
                }
              },
              itemBuilder: (_) => const [
                PopupMenuItem(
                  value: 'export',
                  child: Text('Export encrypted backup'),
                ),
                PopupMenuItem(
                  value: 'import',
                  child: Text('Restore encrypted backup'),
                ),
                PopupMenuItem(
                  value: 'test',
                  child: Text('Test encrypted backup'),
                ),
              ],
            ),
            IconButton(
              tooltip: 'Lock vault',
              onPressed: _vault.lock,
              icon: const Icon(Icons.lock_outline),
            ),
          ],
        ],
      ),
      body: SafeArea(
        child: Platform.isIOS && _obscured
            ? const ColoredBox(color: _ink, child: SizedBox.expand())
            : _body(),
      ),
    ),
  );

  Widget _body() {
    switch (_vault.phase) {
      case VaultPhase.loading:
        return const Center(child: CircularProgressIndicator());
      case VaultPhase.setup:
        return _gate(
          eyebrow: 'YOUR PRIVATE SPACE',
          title: 'Every password. One safe place.',
          icon: Icons.shield_outlined,
          explanation: 'Your passwords stay encrypted on this phone. Create the vault, pair TBD Codes, then make a backup before saving an account.',
          primary: 'CREATE VAULT',
          onPrimary: _vault.create,
          secondary: 'RESTORE ENCRYPTED BACKUP',
          onSecondary: _import,
        );
      case VaultPhase.locked:
        return _gate(
          eyebrow: 'LOCKED / OFFLINE',
          title: 'Only you can open this.',
          icon: Icons.lock_outline,
          explanation: 'Use your phone’s fingerprint, Face ID, or passcode. You will then enter the code from TBD Codes.',
          primary: 'UNLOCK WITH PHONE',
          onPrimary: _vault.unlockDevice,
          secondary: 'RESTORE ENCRYPTED BACKUP',
          onSecondary: _import,
        );
      case VaultPhase.code:
        return _codeGate();
      case VaultPhase.open:
        final data = _vault.data!;
        if (_editing) return _editScreen(data);
        if (_selectedId != null) {
          final matches = data.entries.where(
            (entry) => entry.id == _selectedId,
          );
          if (matches.isNotEmpty) return _detail(matches.first);
        }
        return _list(data);
    }
  }

  Widget _gate({
    required String eyebrow,
    required String title,
    required IconData icon,
    required String explanation,
    required String primary,
    required VoidCallback onPrimary,
    required String secondary,
    required VoidCallback onSecondary,
  }) => SingleChildScrollView(
    padding: const EdgeInsets.all(24),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 55),
        Text(
          eyebrow,
          style: const TextStyle(
            color: _red,
            fontFamily: 'IBM Plex Mono',
            letterSpacing: 2,
            fontSize: 12,
          ),
        ),
        const SizedBox(height: 16),
        Text(
          title,
          style: const TextStyle(
            fontFamily: 'Bebas Neue',
            fontSize: 58,
            height: 0.94,
          ),
        ),
        const SizedBox(height: 28),
        _panel(
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, color: _red, size: 42),
              const SizedBox(height: 20),
              Text(explanation),
              const SizedBox(height: 25),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _vault.busy ? null : onPrimary,
                  child: Text(primary),
                ),
              ),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton(
                  onPressed: _vault.busy ? null : onSecondary,
                  child: Text(secondary),
                ),
              ),
            ],
          ),
        ),
        if (_vault.message != null) ...[
          const SizedBox(height: 14),
          Text(_vault.message!, style: const TextStyle(color: _red)),
        ],
        const SizedBox(height: 40),
        const Text(
          'NO ACCOUNT  •  NO CLOUD  •  NO INTERNET',
          style: TextStyle(
            color: Colors.white38,
            fontFamily: 'IBM Plex Mono',
            fontSize: 10,
          ),
        ),
      ],
    ),
  );

  Widget _codeGate() => SingleChildScrollView(
    padding: const EdgeInsets.all(24),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 55),
        const Text(
          'SECOND CHECK',
          style: TextStyle(
            color: _red,
            fontFamily: 'IBM Plex Mono',
            letterSpacing: 2,
            fontSize: 12,
          ),
        ),
        const SizedBox(height: 14),
        const Text(
          'Enter your current code.',
          style: TextStyle(
            fontFamily: 'Bebas Neue',
            fontSize: 52,
            height: 0.96,
          ),
        ),
        const SizedBox(height: 16),
        const Text(
          'Open TBD Codes, copy its eight-digit code, then return here.',
        ),
        const SizedBox(height: 25),
        TextField(
          controller: _code,
          autofocus: true,
          maxLength: 8,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          style: const TextStyle(
            fontFamily: 'IBM Plex Mono',
            fontSize: 28,
            letterSpacing: 5,
          ),
          decoration: const InputDecoration(
            labelText: 'Eight-digit code',
            counterText: '',
          ),
          onSubmitted: (_) => _verify(),
        ),
        const SizedBox(height: 14),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _vault.busy ? null : _verify,
            child: const Text('OPEN VAULT'),
          ),
        ),
        SizedBox(
          width: double.infinity,
          child: OutlinedButton(
            onPressed: _vault.busy ? null : _vault.pairAgain,
            child: const Text('PAIR CODES AGAIN'),
          ),
        ),
        if (_vault.message != null) ...[
          const SizedBox(height: 12),
          Text(_vault.message!, style: const TextStyle(color: _red)),
        ],
        const SizedBox(height: 30),
        TextButton(
          onPressed: _import,
          child: const Text('Restore an encrypted backup'),
        ),
      ],
    ),
  );

  Widget _list(VaultData data) {
    final query = _search.text.trim().toLowerCase();
    final entries =
        data.entries
            .where(
              (entry) =>
                  entry.name.toLowerCase().contains(query) ||
                  entry.site.toLowerCase().contains(query) ||
                  entry.username.toLowerCase().contains(query),
            )
            .toList()
          ..sort(
            (a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()),
          );
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'YOUR ACCOUNTS',
            style: TextStyle(
              color: _red,
              fontFamily: 'IBM Plex Mono',
              letterSpacing: 2,
              fontSize: 12,
            ),
          ),
          const SizedBox(height: 10),
          Text(
            '${data.entries.length} saved',
            style: const TextStyle(fontFamily: 'Bebas Neue', fontSize: 43),
          ),
          if (data.backupOutdated) ...[
            const SizedBox(height: 12),
            _panel(
              Row(
                children: [
                  const Expanded(
                    child: Text(
                      'Backup needed. New changes are only on this phone.',
                      style: TextStyle(fontSize: 12),
                    ),
                  ),
                  TextButton(onPressed: _export, child: const Text('BACK UP')),
                ],
              ),
            ),
          ],
          const SizedBox(height: 15),
          TextField(
            controller: _search,
            onChanged: (_) => setState(() {}),
            decoration: const InputDecoration(
              prefixIcon: Icon(Icons.search),
              hintText: 'Search accounts',
            ),
          ),
          const SizedBox(height: 15),
          Expanded(
            child: entries.isEmpty
                ? Center(
                    child: Text(
                      data.entries.isEmpty
                          ? 'No passwords yet. Add your first account.'
                          : 'No matching account.',
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: Colors.white54),
                    ),
                  )
                : ListView.separated(
                    itemCount: entries.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 8),
                    itemBuilder: (_, index) {
                      final entry = entries[index];
                      return _panel(
                        ListTile(
                          contentPadding: EdgeInsets.zero,
                          leading: CircleAvatar(
                            backgroundColor: _red,
                            child: Text(
                              entry.name.characters.first.toUpperCase(),
                              style: const TextStyle(
                                color: _paper,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                          title: Text(entry.name),
                          subtitle: Text(
                            entry.username.isNotEmpty
                                ? entry.username
                                : entry.site,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          trailing: const Icon(Icons.chevron_right),
                          onTap: () => setState(() => _selectedId = entry.id),
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }

  Widget _detail(VaultEntry entry) => SingleChildScrollView(
    padding: const EdgeInsets.all(24),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextButton.icon(
          onPressed: () => setState(() {
            _selectedId = null;
            _showPassword = false;
          }),
          icon: const Icon(Icons.arrow_back),
          label: const Text('ALL ACCOUNTS'),
        ),
        const SizedBox(height: 25),
        Text(
          entry.name,
          style: const TextStyle(fontFamily: 'Bebas Neue', fontSize: 52),
        ),
        const SizedBox(height: 20),
        _detailRow('WEBSITE / PLATFORM', entry.site.isEmpty ? '—' : entry.site),
        _detailRow(
          'USERNAME',
          entry.username.isEmpty ? '—' : entry.username,
          onCopy: entry.username.isEmpty
              ? null
              : () => _copy(entry.username, 'Username'),
        ),
        _detailRow(
          'PASSWORD',
          _showPassword ? entry.password : '••••••••••••',
          onCopy: () => _copy(entry.password, 'Password'),
          onReveal: () => setState(() => _showPassword = !_showPassword),
        ),
        const SizedBox(height: 25),
        SizedBox(
          width: double.infinity,
          child: FilledButton.icon(
            onPressed: () => setState(() => _editing = true),
            icon: const Icon(Icons.edit_outlined),
            label: const Text('EDIT ACCOUNT'),
          ),
        ),
        SizedBox(
          width: double.infinity,
          child: TextButton.icon(
            onPressed: () => _delete(entry),
            icon: const Icon(Icons.delete_outline),
            label: const Text('DELETE ACCOUNT'),
          ),
        ),
      ],
    ),
  );

  Widget _detailRow(
    String label,
    String value, {
    VoidCallback? onCopy,
    VoidCallback? onReveal,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: _panel(
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: const TextStyle(
              color: _red,
              fontFamily: 'IBM Plex Mono',
              letterSpacing: 1.5,
              fontSize: 11,
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: Text(
                  value,
                  style: const TextStyle(fontSize: 17),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (onReveal != null)
                IconButton(
                  onPressed: onReveal,
                  tooltip: 'Show or hide password',
                  icon: Icon(
                    _showPassword ? Icons.visibility_off : Icons.visibility,
                  ),
                ),
              if (onCopy != null)
                IconButton(
                  onPressed: onCopy,
                  tooltip: 'Copy',
                  icon: const Icon(Icons.copy),
                ),
            ],
          ),
        ],
      ),
    ),
  );

  Widget _editScreen(VaultData data) {
    final current = _selectedId == null
        ? null
        : data.entries.where((entry) => entry.id == _selectedId).firstOrNull;
    return EntryEditor(
      key: ValueKey(current?.id ?? 'new'),
      entry: current,
      onCancel: () => setState(() => _editing = false),
      onSave: (name, site, username, password) async {
        try {
          await _vault.saveEntry(
            id: current?.id,
            name: name,
            site: site,
            username: username,
            password: password,
          );
          if (mounted) setState(() => _editing = false);
        } catch (error) {
          _toast(
            error is StateError
                ? error.message
                : 'Check the fields and try again.',
          );
        }
      },
    );
  }

  Widget _panel(Widget child) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(18),
    decoration: BoxDecoration(
      color: const Color(0xff151515),
      borderRadius: BorderRadius.circular(22),
      border: Border.all(color: Colors.white12),
    ),
    child: child,
  );
}

class EntryEditor extends StatefulWidget {
  const EntryEditor({
    super.key,
    required this.entry,
    required this.onCancel,
    required this.onSave,
  });
  final VaultEntry? entry;
  final VoidCallback onCancel;
  final Future<void> Function(String, String, String, String) onSave;

  @override
  State<EntryEditor> createState() => _EntryEditorState();
}

class _EntryEditorState extends State<EntryEditor> {
  late final _name = TextEditingController(text: widget.entry?.name ?? '');
  late final _site = TextEditingController(text: widget.entry?.site ?? '');
  late final _username = TextEditingController(
    text: widget.entry?.username ?? '',
  );
  late final _password = TextEditingController(
    text: widget.entry?.password ?? '',
  );
  bool _visible = false;
  bool _saving = false;

  @override
  void dispose() {
    _name.dispose();
    _site.dispose();
    _username.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_saving) return;
    setState(() => _saving = true);
    try {
      await widget.onSave(
        _name.text,
        _site.text,
        _username.text,
        _password.text,
      );
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    padding: const EdgeInsets.all(24),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextButton.icon(
          onPressed: widget.onCancel,
          icon: const Icon(Icons.arrow_back),
          label: const Text('BACK'),
        ),
        const SizedBox(height: 20),
        Text(
          widget.entry == null ? 'New account' : 'Edit account',
          style: const TextStyle(fontFamily: 'Bebas Neue', fontSize: 52),
        ),
        const SizedBox(height: 22),
        TextField(
          controller: _name,
          decoration: const InputDecoration(labelText: 'Account name *'),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _site,
          decoration: const InputDecoration(labelText: 'Website or platform'),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _username,
          decoration: const InputDecoration(labelText: 'Username or email'),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _password,
          obscureText: !_visible,
          enableSuggestions: false,
          autocorrect: false,
          decoration: InputDecoration(
            labelText: 'Password *',
            suffixIcon: IconButton(
              onPressed: () => setState(() => _visible = !_visible),
              icon: Icon(_visible ? Icons.visibility_off : Icons.visibility),
            ),
          ),
        ),
        const SizedBox(height: 22),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _saving ? null : _submit,
            child: const Text('SAVE PASSWORD'),
          ),
        ),
      ],
    ),
  );
}
