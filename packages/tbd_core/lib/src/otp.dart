import 'dart:convert';

import 'package:crypto/crypto.dart';

class Otp {
  static int step(DateTime time, int period) =>
      time.toUtc().millisecondsSinceEpoch ~/ (period * 1000);

  static int secondsLeft(DateTime time, int period) {
    final remainder = time.toUtc().millisecondsSinceEpoch ~/ 1000 % period;
    return period - remainder;
  }

  static String code(List<int> secret, DateTime time, int period) {
    if (secret.length != 32)
      throw ArgumentError('Code secret must be 32 bytes');
    if (period <= 0) throw ArgumentError('Period must be positive');
    var counter = step(time, period);
    final bytes = List<int>.filled(8, 0);
    for (var i = 7; i >= 0; i--) {
      bytes[i] = counter & 0xff;
      counter >>= 8;
    }
    final digest = Hmac(sha256, secret).convert(bytes).bytes;
    final offset = digest.last & 0x0f;
    final value =
        ((digest[offset] & 0x7f) << 24) |
        ((digest[offset + 1] & 0xff) << 16) |
        ((digest[offset + 2] & 0xff) << 8) |
        (digest[offset + 3] & 0xff);
    return (value % 100000000).toString().padLeft(8, '0');
  }

  static bool matches(
    String input,
    String base64Secret,
    DateTime time,
    int period,
  ) {
    if (!RegExp(r'^\d{8}$').hasMatch(input)) return false;
    final expected = code(base64Decode(base64Secret), time, period);
    var diff = 0;
    for (var i = 0; i < 8; i++) {
      diff |= input.codeUnitAt(i) ^ expected.codeUnitAt(i);
    }
    return diff == 0;
  }
}
