/**
 * Admin Settings JavaScript
 *
 * @package Kelbe_Project_Tracker
 */

(function($) {
    'use strict';
    
    $(document).ready(function() {
        
        // Initialize color pickers
        if ($.fn.wpColorPicker) {
            $('.color-picker').wpColorPicker();
        }
        
        // Logo upload
        $('#upload-logo-btn').on('click', function(e) {
            e.preventDefault();
            
            var mediaUploader = wp.media({
                title: 'Select Company Logo',
                button: { text: 'Use this image' },
                multiple: false,
                library: { type: 'image' }
            });
            
            mediaUploader.on('select', function() {
                var attachment = mediaUploader.state().get('selection').first().toJSON();
                $('#company_logo').val(attachment.url);
                $('#logo-preview').html('<img src="' + attachment.url + '" style="max-width: 200px; height: auto;">');
            });
            
            mediaUploader.open();
        });
        
        // Remove logo
        $('#remove-logo-btn').on('click', function(e) {
            e.preventDefault();
            $('#company_logo').val('');
            $('#logo-preview').html('');
            $(this).hide();
        });
        
        // Make trade types sortable
        if ($.fn.sortable) {
            $('#trade-types-list').sortable({
                handle: '.handle',
                axis: 'y',
                update: function() {
                    updateTradeTypeIndexes();
                }
            });
        }
        
        // Add trade type
        $('#add-trade-type').on('click', function() {
            var index = $('#trade-types-list .trade-type-item').length;
            var template = '<div class="trade-type-item" data-index="' + index + '">' +
                '<span class="dashicons dashicons-menu handle"></span>' +
                '<input type="text" name="kpt_settings[trade_types][' + index + '][name]" placeholder="Trade Type Name">' +
                '<input type="text" name="kpt_settings[trade_types][' + index + '][icon]" placeholder="Icon (dashicon name)" class="small-text">' +
                '<input type="text" name="kpt_settings[trade_types][' + index + '][color]" class="color-picker" value="#0073aa">' +
                '<button type="button" class="button remove-trade-type">Remove</button>' +
                '</div>';
            
            $('#trade-types-list').append(template);
            $('.color-picker').wpColorPicker();
        });
        
        // Remove trade type
        $(document).on('click', '.remove-trade-type', function() {
            if (confirm(kptSettings.strings.confirm_delete)) {
                $(this).closest('.trade-type-item').remove();
                updateTradeTypeIndexes();
            }
        });
        
        // Add bid item
        $(document).on('click', '.add-bid-item', function() {
            var tradeType = $(this).data('trade-type');
            var itemIndex = $(this).siblings('.bid-items-list').find('.bid-item').length;
            
            var template = '<div class="bid-item">' +
                '<input type="text" name="kpt_settings[bid_items][' + tradeType + '][' + itemIndex + '][name]" placeholder="Item Name">' +
                '<select name="kpt_settings[bid_items][' + tradeType + '][' + itemIndex + '][required]">' +
                '<option value="0">Optional</option>' +
                '<option value="1">Required</option>' +
                '</select>' +
                '<button type="button" class="button remove-bid-item">Remove</button>' +
                '</div>';
            
            $(this).siblings('.bid-items-list').append(template);
        });
        
        // Remove bid item
        $(document).on('click', '.remove-bid-item', function() {
            $(this).closest('.bid-item').remove();
        });
        
        // AJAX form submission
        $('#kpt-settings-form').on('submit', function(e) {
            e.preventDefault();
            
            var $submitBtn = $(this).find('[type="submit"]');
            var originalText = $submitBtn.val();
            
            $submitBtn.prop('disabled', true).val('Saving...');
            
            $.ajax({
                url: kptSettings.ajax_url,
                type: 'POST',
                data: {
                    action: 'kpt_save_settings',
                    nonce: kptSettings.nonce,
                    settings: $(this).serialize()
                },
                success: function(response) {
                    if (response.success) {
                        showNotice('success', kptSettings.strings.saved);
                    } else {
                        showNotice('error', response.data.message || kptSettings.strings.error);
                    }
                },
                error: function() {
                    showNotice('error', kptSettings.strings.error);
                },
                complete: function() {
                    $submitBtn.prop('disabled', false).val(originalText);
                }
            });
        });
        
        function updateTradeTypeIndexes() {
            $('#trade-types-list .trade-type-item').each(function(index) {
                $(this).attr('data-index', index);
                $(this).find('input, select').each(function() {
                    var name = $(this).attr('name');
                    if (name) {
                        name = name.replace(/\[\d+\]/, '[' + index + ']');
                        $(this).attr('name', name);
                    }
                });
            });
        }
        
        function showNotice(type, message) {
            var $notice = $('<div class="notice notice-' + type + ' is-dismissible"><p>' + message + '</p></div>');
            $('.kpt-settings-wrap h1').after($notice);
            
            setTimeout(function() {
                $notice.fadeOut(function() {
                    $(this).remove();
                });
            }, 3000);
        }
    });
    
})(jQuery);
