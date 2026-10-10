import 'dart:convert';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:tbd_core/tbd_core.dart';
import 'package:tbd_platform/tbd_platform.dart';

enum VaultPhase { loading, setup, locked, code, open }

class VaultController extends ChangeNotifier {
  VaultController({
    DeviceSecrets? secrets,
    PrivatePairing? pairing,
    DateTime Function()? clock,
    Future<Directory> Function()? storageFolder,
  }) : _secrets = secrets ?? DeviceSecrets(),
       _pairing = pairing ?? PrivatePairing(),
       _clock = clock ?? DateTime.now,
       _storageFolder = storageFolder ?? getApplicationSupportDirectory;

  final DeviceSecrets _secrets;
  final PrivatePairing _pairing;
  final DateTime Function() _clock;
  final Future<Directory> Function() _storageFolder;
  late VaultFile _vaultFile;
  late File _attemptFile;
  Uint8List? _key;
  VaultData? _data;

  VaultPhase phase = VaultPhase.loading;
  bool busy = false;
  String? message;
  VaultData? get data => phase == VaultPhase.open ? _data : null;
  bool get backupOutdated => _data?.backupOutdated ?? true;

  Future<void> initialize() async {
    try {
      final folder = await _storageFolder();
      _vaultFile = VaultFile(File('${folder.path}/vault.tbd'));
      _attemptFile = File('${folder.path}/attempts.json');
      phase = await _vaultFile.exists() ? VaultPhase.locked : VaultPhase.setup;
    } catch (_) {
      phase = VaultPhase.setup;
      message = 'Could not open local storage on this device.';
    }
    notifyListeners();
  }

  Future<void> create() async {
    if (busy || phase != VaultPhase.setup) return;
    busy = true;
    message = null;
    notifyListeners();
    try {
      final key = randomBytes(32);
      final secret = randomBytes(32);
      final vault = VaultData(
        entries: const [],
        otpSecret: base64Encode(secret),
        period: 10,
        revision: 0,
        lastBackupRevision: -1,
        lastAcceptedStep: -1,
      );
      await _secrets.write('vaultKey', key);
      await _vaultFile.write(vault, key);
      _key = key;
      _data = vault;
      await _pairing.publish(secret, 10);
      phase = VaultPhase.code;
      message = 'Vault created. Open TBD Codes and tap Pair with Vault.';
    } catch (_) {
      message = 'Setup failed. Set a phone passcode and try again.';
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  Future<void> unlockDevice() async {
    if (busy || phase != VaultPhase.locked) return;
    busy = true;
    message = null;
    notifyListeners();
    try {
      final key = await _secrets.read('vaultKey');
      if (key == null) {
        throw StateError(
          'Device key is missing. Restore your encrypted backup.',
        );
      }
      var vault = await _vaultFile.read(key);
      final period = await _pairing.readPeriod() ?? vault.period;
      if (period != vault.period) {
        vault = vault.copyWith(period: period, revision: vault.revision + 1);
        await _vaultFile.write(vault, key);
      }
      _key = key;
      _data = vault;
      phase = VaultPhase.code;
    } catch (error) {
      message = error is StateError
          ? error.message
          : 'Could not unlock. Check your phone lock or restore a backup.';
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  Future<bool> verifyCode(String input) async {
    final key = _key;
    var vault = _data;
    if (busy || phase != VaultPhase.code || key == null || vault == null) {
      return false;
    }
    busy = true;
    message = null;
    notifyListeners();
    try {
      final currentPeriod = await _pairing.readPeriod() ?? vault.period;
      if (currentPeriod != vault.period) {
        vault = vault.copyWith(
          period: currentPeriod,
          revision: vault.revision + 1,
        );
        await _vaultFile.write(vault, key);
        _data = vault;
      }
      final attempts = await _readAttempts();
      final now = _clock();
      if (attempts.blockedUntil.isAfter(now)) {
        final seconds = attempts.blockedUntil.difference(now).inSeconds + 1;
        message = 'Too many tries. Wait $seconds seconds.';
        return false;
      }
      final step = Otp.step(now, vault.period);
      final valid =
          step > vault.lastAcceptedStep &&
          Otp.matches(input, vault.otpSecret, now, vault.period);
      if (!valid) {
        final failures = attempts.failures + 1;
        final cooldown = failures >= 5
            ? now.add(const Duration(seconds: 30))
            : DateTime.fromMillisecondsSinceEpoch(0);
        await _writeAttempts(_Attempts(failures >= 5 ? 0 : failures, cooldown));
        message = failures >= 5 ? 'Too many tries. Wait 30 seconds.' : 'Code did not match or already expired. Copy the new code and retry.';
        return false;
      }
      await _writeAttempts(
        _Attempts(0, DateTime.fromMillisecondsSinceEpoch(0)),
      );
      final opened = vault.copyWith(lastAcceptedStep: step);
      await _vaultFile.write(opened, key);
      _data = opened;
      phase = VaultPhase.open;
      return true;
    } catch (_) {
      message = 'Could not verify code. Try again.';
      return false;
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  Future<void> pairAgain() async {
    final vault = _data;
    if (vault == null) return;
    busy = true;
    message = null;
    notifyListeners();
    try {
      await _pairing.publish(base64Decode(vault.otpSecret), vault.period);
      message = 'Pairing is ready for five minutes. Open TBD Codes.';
    } catch (_) {
      message = 'Could not pair the apps. Check that both are installed and signed together.';
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  Future<void> saveEntry({
    String? id,
    required String name,
    required String site,
    required String username,
    required String password,
  }) async {
    final key = _key;
    final vault = _data;
    if (phase != VaultPhase.open || key == null || vault == null) {
      throw StateError('Unlock the vault first');
    }
    if (vault.lastBackupRevision < 0) {
      throw StateError('Create your first backup before adding passwords');
    }
    if (name.trim().isEmpty || password.isEmpty) {
      throw ArgumentError('Account name and password are required');
    }
    final now = DateTime.now().toUtc();
    final existing = id == null
        ? null
        : vault.entries.where((entry) => entry.id == id).firstOrNull;
    final entry = VaultEntry(
      id: id ?? base64UrlEncode(randomBytes(12)).replaceAll('=', ''),
      name: name.trim(),
      site: site.trim(),
      username: username.trim(),
      password: password,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    );
    final entries = [...vault.entries.where((item) => item.id != id), entry];
    final updated = vault.copyWith(
      entries: entries,
      revision: vault.revision + 1,
    );
    await _vaultFile.write(updated, key);
    _data = updated;
    notifyListeners();
  }

  Future<void> deleteEntry(String id) async {
    final key = _key;
    final vault = _data;
    if (phase != VaultPhase.open || key == null || vault == null) {
      throw StateError('Unlock the vault first');
    }
    final updated = vault.copyWith(
      entries: vault.entries.where((item) => item.id != id).toList(),
      revision: vault.revision + 1,
    );
    await _vaultFile.write(updated, key);
    _data = updated;
    notifyListeners();
  }

  Future<bool> exportBackup(String password) async {
    final vault = _data;
    final key = _key;
    if (phase != VaultPhase.open || vault == null || key == null) {
      throw StateError('Unlock the vault first');
    }
    final fresh = vault.copyWith(lastBackupRevision: vault.revision);
    final bytes = await BackupCrypto.create(fresh, password);
    final verified = await BackupCrypto.restore(bytes, password);
    if (verified.entries.length != fresh.entries.length ||
        verified.otpSecret != fresh.otpSecret) {
      throw StateError('Backup verification failed');
    }
    final saved = await FilePicker.saveFile(
      fileName:
          'TBD-Vault-${DateTime.now().toUtc().toIso8601String().replaceAll(':', '-')}.tbdbackup',
      bytes: bytes,
      mimeType: 'application/octet-stream',
      dialogTitle: 'Save encrypted backup',
    );
    if (saved == null) return false;
    await _vaultFile.write(fresh, key);
    if (phase == VaultPhase.open && identical(_data, vault)) {
      _data = fresh;
      notifyListeners();
    }
    return true;
  }

  Future<bool> importBackup(String password) async {
    if (phase != VaultPhase.setup &&
        phase != VaultPhase.locked &&
        _key == null) {
      throw StateError('Unlock this phone before replacing its vault');
    }
    final currentKey =
        _key ??
        (await _vaultFile.exists() ? await _secrets.read('vaultKey') : null);
    final bytes = await _pickBackupBytes();
    if (bytes == null) return false;
    final restored = await BackupCrypto.restore(bytes, password);
    final key = currentKey ?? randomBytes(32);
    if (currentKey == null) await _secrets.write('vaultKey', key);
    final ready = restored.copyWith(
      lastBackupRevision: restored.revision,
      lastAcceptedStep: -1,
    );
    await _vaultFile.write(ready, key);
    _key = key;
    _data = ready;
    await _pairing.publish(base64Decode(ready.otpSecret), ready.period);
    phase = VaultPhase.code;
    message = 'Backup restored. Pair TBD Codes on this phone to unlock.';
    notifyListeners();
    return true;
  }

  Future<int?> testBackup(String password) async {
    final bytes = await _pickBackupBytes();
    if (bytes == null) return null;
    final restored = await BackupCrypto.restore(bytes, password);
    return restored.entries.length;
  }

  Future<List<int>?> _pickBackupBytes() async {
    final picked = await FilePicker.pickFile(
      dialogTitle: 'Choose encrypted TBD backup',
    );
    if (picked == null) return null;
    if (!picked.name.toLowerCase().endsWith('.tbdbackup')) {
      throw const FormatException('Choose a .tbdbackup file');
    }
    final length = picked.lengthSync() ?? await picked.length();
    if (length != null && length > BackupCrypto.maxBytes) {
      throw const FormatException('Backup file is too large');
    }
    final bytes = <int>[];
    await for (final chunk in picked.readAsByteStream()) {
      if (bytes.length + chunk.length > BackupCrypto.maxBytes) {
        throw const FormatException('Backup file is too large');
      }
      bytes.addAll(chunk);
    }
    return bytes;
  }

  void lock() {
    if (phase != VaultPhase.open && phase != VaultPhase.code) return;
    _key = null;
    _data = null;
    phase = VaultPhase.locked;
    message = null;
    notifyListeners();
  }

  Future<_Attempts> _readAttempts() async {
    if (!await _attemptFile.exists()) {
      return _Attempts(0, DateTime.fromMillisecondsSinceEpoch(0));
    }
    try {
      final json =
          jsonDecode(await _attemptFile.readAsString()) as Map<String, dynamic>;
      return _Attempts(
        json['failures'] as int,
        DateTime.fromMillisecondsSinceEpoch(json['blockedUntil'] as int),
      );
    } catch (_) {
      return _Attempts(5, _clock().add(const Duration(seconds: 30)));
    }
  }

  Future<void> _writeAttempts(_Attempts attempts) async {
    await _attemptFile.writeAsString(
      jsonEncode({
        'failures': attempts.failures,
        'blockedUntil': attempts.blockedUntil.millisecondsSinceEpoch,
      }),
      flush: true,
    );
  }
}

class _Attempts {
  const _Attempts(this.failures, this.blockedUntil);
  final int failures;
  final DateTime blockedUntil;
}
