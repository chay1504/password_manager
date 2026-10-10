import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class DeviceSecrets {
  DeviceSecrets()
    : _storage = const FlutterSecureStorage(
        aOptions: AndroidOptions.biometric(
          enforceBiometrics: true,
          biometricType: AndroidBiometricType.biometricOrDeviceCredential,
          biometricPromptTitle: 'Unlock TBD',
        ),
        iOptions: IOSOptions(
          accessibility: KeychainAccessibility.passcode,
          accessControlFlags: [AccessControlFlag.userPresence],
          synchronizable: false,
        ),
      );

  final FlutterSecureStorage _storage;

  Future<Uint8List?> read(String name) async {
    final value = await _storage.read(key: name);
    return value == null ? null : base64Decode(value);
  }

  Future<void> write(String name, List<int> bytes) =>
      _storage.write(key: name, value: base64Encode(bytes));

  Future<void> delete(String name) => _storage.delete(key: name);
}

class PairingData {
  const PairingData(this.secret, this.period);
  final Uint8List secret;
  final int period;
}

class PrivatePairing {
  static const _channel = MethodChannel('com.techboydeepak.tbd/pairing');
  static const _teamId = String.fromEnvironment('TBD_TEAM_ID');

  FlutterSecureStorage get _iosShared {
    if (_teamId.isEmpty) {
      throw StateError(
        'Build both iPhone apps with TBD_TEAM_ID set to the Apple Team ID',
      );
    }
    return FlutterSecureStorage(
      iOptions: IOSOptions(
        groupId: '$_teamId.com.techboydeepak.tbd.shared',
        accessibility: KeychainAccessibility.passcode,
        synchronizable: false,
      ),
    );
  }

  Future<void> publish(List<int> secret, int period) async {
    if (secret.length != 32 || period < 5 || period > 10) {
      throw ArgumentError('Invalid pairing details');
    }
    if (Platform.isIOS) {
      await _iosShared.write(
        key: 'pending',
        value: jsonEncode({
          'secret': base64Encode(secret),
          'period': period,
          'createdAt': DateTime.now().toUtc().millisecondsSinceEpoch,
        }),
      );
      await writePeriod(period);
    } else {
      await _channel.invokeMethod<void>('publish', {
        'secret': base64Encode(secret),
        'period': period,
      });
    }
  }

  Future<PairingData?> consume() async {
    Map<String, dynamic>? value;
    if (Platform.isIOS) {
      final raw = await _iosShared.read(key: 'pending');
      if (raw == null) return null;
      await _iosShared.delete(key: 'pending');
      value = jsonDecode(raw) as Map<String, dynamic>;
      final age =
          DateTime.now().toUtc().millisecondsSinceEpoch -
          (value['createdAt'] as int);
      if (age < 0 || age > 5 * 60 * 1000) return null;
    } else {
      value = await _channel.invokeMapMethod<String, dynamic>('consume');
    }
    if (value == null) return null;
    final secret = base64Decode(value['secret'] as String);
    final period = value['period'] as int;
    if (secret.length != 32 || period < 5 || period > 10) {
      throw const FormatException('Invalid pairing record');
    }
    return PairingData(secret, period);
  }

  Future<int?> readPeriod() async {
    final int? value;
    if (Platform.isIOS) {
      final raw = await _iosShared.read(key: 'period');
      value = raw == null ? null : int.tryParse(raw);
    } else {
      value = await _channel.invokeMethod<int>('readPeriod');
    }
    return value != null && value >= 5 && value <= 10 ? value : null;
  }

  Future<void> writePeriod(int period) async {
    if (period < 5 || period > 10) throw ArgumentError('Invalid period');
    if (Platform.isIOS) {
      await _iosShared.write(key: 'period', value: period.toString());
    } else {
      await _channel.invokeMethod<void>('writePeriod', {'period': period});
    }
  }
}

/// Copies sensitive text with the strongest clearing the platform allows.
///
/// iPhone: the system pasteboard item is marked local-only and expires on its
/// own, even if this app is suspended. Android: the item is flagged sensitive
/// (hidden from clipboard previews on Android 13+); Android has no expiry, so
/// the text is cleared from the foreground after [expiry], when the app
/// returns to the foreground, or when [clearIfCodeShaped] is called.
class SecureClipboard {
  static const _channel = MethodChannel('com.techboydeepak.tbd/clipboard');

  String? _lastCopied;
  Timer? _timer;

  Future<void> copy(String text, {required Duration expiry}) async {
    try {
      await _channel.invokeMethod<void>('copy', {
        'text': text,
        'expirySeconds': expiry.inSeconds,
      });
    } on MissingPluginException {
      await Clipboard.setData(ClipboardData(text: text));
    }
    _lastCopied = text;
    _timer?.cancel();
    _timer = Timer(expiry, clearIfStillCopied);
  }

  /// Clears the clipboard if it still holds the last text this app copied.
  Future<void> clearIfStillCopied() async {
    final last = _lastCopied;
    if (last == null) return;
    if (await _clearWhen((text) => text == last)) _lastCopied = null;
  }

  /// Clears the clipboard if it holds an eight-digit code. TBD Vault calls
  /// this after a code is submitted, because the app that copied the code
  /// (TBD Codes) is in the background and cannot clear it.
  Future<void> clearIfCodeShaped() =>
      _clearWhen((text) => RegExp(r'^\d{8}$').hasMatch(text.trim()));

  Future<bool> _clearWhen(bool Function(String text) test) async {
    try {
      final current = await Clipboard.getData(Clipboard.kTextPlain);
      final text = current?.text;
      if (text == null || !test(text)) return false;
      await Clipboard.setData(const ClipboardData(text: ''));
      return true;
    } catch (_) {
      return false; // Not allowed while in the background; retry on resume.
    }
  }

  void dispose() => _timer?.cancel();
}
