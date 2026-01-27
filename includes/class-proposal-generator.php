<?php
/**
 * Proposal Generator
 *
 * Generates proposals from accepted bids
 *
 * @package Kelbe_Project_Tracker
 */

// Exit if accessed directly
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Proposal Generator class
 */
class KPT_Proposal_Generator {
    
    /**
     * Single instance of the class
     *
     * @var KPT_Proposal_Generator
     */
    private static $instance = null;
    
    /**
     * Get instance
     *
     * @return KPT_Proposal_Generator
     */
    public static function get_instance() {
        if (null === self::$instance) {
            self::$instance = new self();
        }
        return self::$instance;
    }
    
    /**
     * Constructor
     */
    private function __construct() {
        add_action('wp_ajax_kpt_generate_proposal_from_bids', array($this, 'ajax_generate_from_bids'));
    }
    
    /**
     * Generate proposal from accepted bids
     *
     * @param int $project_id Project ID
     * @param array $bid_ids Optional array of specific bid IDs to include
     * @return int|false Proposal ID on success, false on failure
     */
    public function generate_from_bids($project_id, $bid_ids = null) {
        global $wpdb;
        
        // Get accepted bids
        $bid_handler = KPT_Bid_Handler::get_instance();
        
        if ($bid_ids) {
            // Get specific bids
            $bids = array();
            foreach ($bid_ids as $bid_id) {
                $bid = $bid_handler->get_bid($bid_id);
                if ($bid && $bid->project_id == $project_id) {
                    $bids[] = $bid;
                }
            }
        } else {
            // Get all accepted bids for the project
            $bids = $bid_handler->get_bids($project_id, 'accepted');
        }
        
        if (empty($bids)) {
            return false;
        }
        
        // Compile line items from all bids
        $line_items = array();
        $subtotal = 0;
        
        foreach ($bids as $bid) {
            // Decode line items if needed
            $bid_line_items = $bid->line_items ? json_decode($bid->line_items, true) : array();
            
            if ($bid_line_items) {
                foreach ($bid_line_items as $item) {
                    $line_items[] = array(
                        'trade_type' => $bid->trade_type,
                        'bid_id' => $bid->id,
                        'description' => isset($item['description']) ? $item['description'] : '',
                        'quantity' => isset($item['quantity']) ? floatval($item['quantity']) : 1,
                        'unit' => isset($item['unit']) ? $item['unit'] : '',
                        'unit_price' => isset($item['unit_price']) ? floatval($item['unit_price']) : 0,
                        'total' => isset($item['quantity']) && isset($item['unit_price']) 
                            ? floatval($item['quantity']) * floatval($item['unit_price']) 
                            : 0,
                    );
                }
            }
            
            $subtotal += floatval($bid->subtotal);
        }
        
        // Calculate totals
        $settings = get_option('kpt_settings', array());
        $tax_rate = isset($settings['tax_rate']) ? floatval($settings['tax_rate']) : 13;
        $deposit_percentage = isset($settings['deposit_percentage']) ? absint($settings['deposit_percentage']) : 30;
        
        $tax = $subtotal * ($tax_rate / 100);
        $total = $subtotal + $tax;
        $deposit_amount = $total * ($deposit_percentage / 100);
        
        // Get proposal terms
        $terms_text = isset($settings['proposal_terms']) ? $settings['proposal_terms'] : '';
        
        // Create proposal
        $proposal_handler = KPT_Proposal_Handler::get_instance();
        
        $proposal_data = array(
            'project_id' => $project_id,
            'line_items' => $line_items,
            'subtotal' => $subtotal,
            'tax' => $tax,
            'total' => $total,
            'deposit_amount' => $deposit_amount,
            'deposit_percentage' => $deposit_percentage,
            'terms_text' => $terms_text,
        );
        
        return $proposal_handler->create_proposal($proposal_data);
    }
    
    /**
     * Generate proposal from custom line items
     *
     * @param int $project_id Project ID
     * @param array $line_items Line items
     * @return int|false Proposal ID on success, false on failure
     */
    public function generate_from_line_items($project_id, $line_items) {
        if (empty($line_items)) {
            return false;
        }
        
        // Calculate subtotal
        $subtotal = 0;
        foreach ($line_items as $item) {
            if (isset($item['quantity']) && isset($item['unit_price'])) {
                $subtotal += floatval($item['quantity']) * floatval($item['unit_price']);
            }
        }
        
        // Calculate totals
        $settings = get_option('kpt_settings', array());
        $tax_rate = isset($settings['tax_rate']) ? floatval($settings['tax_rate']) : 13;
        $deposit_percentage = isset($settings['deposit_percentage']) ? absint($settings['deposit_percentage']) : 30;
        
        $tax = $subtotal * ($tax_rate / 100);
        $total = $subtotal + $tax;
        $deposit_amount = $total * ($deposit_percentage / 100);
        
        // Get proposal terms
        $terms_text = isset($settings['proposal_terms']) ? $settings['proposal_terms'] : '';
        
        // Create proposal
        $proposal_handler = KPT_Proposal_Handler::get_instance();
        
        $proposal_data = array(
            'project_id' => $project_id,
            'line_items' => $line_items,
            'subtotal' => $subtotal,
            'tax' => $tax,
            'total' => $total,
            'deposit_amount' => $deposit_amount,
            'deposit_percentage' => $deposit_percentage,
            'terms_text' => $terms_text,
        );
        
        return $proposal_handler->create_proposal($proposal_data);
    }
    
    /**
     * Generate proposal HTML
     *
     * @param object $proposal Proposal object
     * @return string HTML content
     */
    public function generate_html($proposal) {
        $project = get_post($proposal->project_id);
        $settings = get_option('kpt_settings', array());
        $company_name = isset($settings['company_name']) ? $settings['company_name'] : get_bloginfo('name');
        
        // Get client info from project meta
        $client_name = get_post_meta($proposal->project_id, '_kpt_client_name', true);
        $client_email = get_post_meta($proposal->project_id, '_kpt_client_email', true);
        $client_phone = get_post_meta($proposal->project_id, '_kpt_client_phone', true);
        $client_address = get_post_meta($proposal->project_id, '_kpt_client_address', true);
        
        ob_start();
        ?>
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title><?php echo esc_html($company_name); ?> - Proposal <?php echo esc_html($proposal->proposal_number); ?></title>
            <style>
                body { font-family: Arial, sans-serif; margin: 40px; color: #333; }
                .header { border-bottom: 3px solid #D6001C; padding-bottom: 20px; margin-bottom: 30px; }
                .header h1 { margin: 0; color: #D6001C; }
                .info-section { margin-bottom: 30px; }
                .info-section h2 { font-size: 18px; margin-bottom: 10px; }
                .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
                table { width: 100%; border-collapse: collapse; margin: 20px 0; }
                th { background: #f4f4f4; padding: 12px; text-align: left; border-bottom: 2px solid #ddd; }
                td { padding: 10px; border-bottom: 1px solid #eee; }
                .total-row { font-weight: bold; background: #f9f9f9; }
                .terms { background: #f9f9f9; padding: 20px; margin: 30px 0; border-left: 4px solid #D6001C; }
                .footer { margin-top: 40px; text-align: center; color: #666; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1><?php echo esc_html($company_name); ?></h1>
                <p><strong><?php esc_html_e('Proposal:', 'kelbe-project-tracker'); ?></strong> <?php echo esc_html($proposal->proposal_number); ?></p>
                <p><strong><?php esc_html_e('Date:', 'kelbe-project-tracker'); ?></strong> <?php echo date_i18n(get_option('date_format')); ?></p>
            </div>
            
            <div class="info-grid">
                <div class="info-section">
                    <h2><?php esc_html_e('Project Information', 'kelbe-project-tracker'); ?></h2>
                    <p><strong><?php esc_html_e('Project:', 'kelbe-project-tracker'); ?></strong> <?php echo esc_html($project->post_title); ?></p>
                </div>
                
                <div class="info-section">
                    <h2><?php esc_html_e('Client Information', 'kelbe-project-tracker'); ?></h2>
                    <?php if ($client_name) : ?>
                        <p><strong><?php esc_html_e('Name:', 'kelbe-project-tracker'); ?></strong> <?php echo esc_html($client_name); ?></p>
                    <?php endif; ?>
                    <?php if ($client_email) : ?>
                        <p><strong><?php esc_html_e('Email:', 'kelbe-project-tracker'); ?></strong> <?php echo esc_html($client_email); ?></p>
                    <?php endif; ?>
                    <?php if ($client_phone) : ?>
                        <p><strong><?php esc_html_e('Phone:', 'kelbe-project-tracker'); ?></strong> <?php echo esc_html($client_phone); ?></p>
                    <?php endif; ?>
                    <?php if ($client_address) : ?>
                        <p><strong><?php esc_html_e('Address:', 'kelbe-project-tracker'); ?></strong> <?php echo esc_html($client_address); ?></p>
                    <?php endif; ?>
                </div>
            </div>
            
            <table>
                <thead>
                    <tr>
                        <th><?php esc_html_e('Description', 'kelbe-project-tracker'); ?></th>
                        <th><?php esc_html_e('Quantity', 'kelbe-project-tracker'); ?></th>
                        <th><?php esc_html_e('Unit Price', 'kelbe-project-tracker'); ?></th>
                        <th><?php esc_html_e('Total', 'kelbe-project-tracker'); ?></th>
                    </tr>
                </thead>
                <tbody>
                    <?php 
                    $line_items = json_decode($proposal->line_items, true);
                    if ($line_items) :
                        foreach ($line_items as $item) : 
                    ?>
                        <tr>
                            <td><?php echo esc_html($item['description']); ?></td>
                            <td><?php echo esc_html($item['quantity']) . ' ' . esc_html($item['unit']); ?></td>
                            <td>$<?php echo number_format($item['unit_price'], 2); ?></td>
                            <td>$<?php echo number_format($item['total'], 2); ?></td>
                        </tr>
                    <?php 
                        endforeach;
                    endif;
                    ?>
                    <tr>
                        <td colspan="3" style="text-align: right;"><strong><?php esc_html_e('Subtotal:', 'kelbe-project-tracker'); ?></strong></td>
                        <td><strong>$<?php echo number_format($proposal->subtotal, 2); ?></strong></td>
                    </tr>
                    <tr>
                        <td colspan="3" style="text-align: right;"><strong><?php esc_html_e('Tax:', 'kelbe-project-tracker'); ?></strong></td>
                        <td><strong>$<?php echo number_format($proposal->tax, 2); ?></strong></td>
                    </tr>
                    <tr class="total-row">
                        <td colspan="3" style="text-align: right;"><strong><?php esc_html_e('Total:', 'kelbe-project-tracker'); ?></strong></td>
                        <td><strong>$<?php echo number_format($proposal->total, 2); ?></strong></td>
                    </tr>
                    <tr class="total-row">
                        <td colspan="3" style="text-align: right;"><strong><?php echo sprintf(__('Deposit (%d%%):', 'kelbe-project-tracker'), $proposal->deposit_percentage); ?></strong></td>
                        <td><strong>$<?php echo number_format($proposal->deposit_amount, 2); ?></strong></td>
                    </tr>
                </tbody>
            </table>
            
            <?php if ($proposal->terms_text) : ?>
            <div class="terms">
                <h2><?php esc_html_e('Terms & Conditions', 'kelbe-project-tracker'); ?></h2>
                <p><?php echo nl2br(esc_html($proposal->terms_text)); ?></p>
            </div>
            <?php endif; ?>
            
            <div class="footer">
                <p><?php echo esc_html($company_name); ?></p>
                <p><?php esc_html_e('Thank you for your business!', 'kelbe-project-tracker'); ?></p>
            </div>
        </body>
        </html>
        <?php
        return ob_get_clean();
    }
    
    /**
     * Generate PDF from proposal
     *
     * @param object $proposal Proposal object
     * @return string|false PDF file path on success, false on failure
     */
    public function generate_pdf($proposal) {
        // Check if DomPDF or similar library is available
        // This is a placeholder - in production, you'd use a PDF library
        
        $html = $this->generate_html($proposal);
        
        // For now, return HTML as fallback
        // In production, implement PDF generation with a library like DomPDF or TCPDF
        
        return false;
    }
    
    /**
     * AJAX: Generate proposal from bids
     */
    public function ajax_generate_from_bids() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $project_id = isset($_POST['project_id']) ? absint($_POST['project_id']) : 0;
        
        if (!$project_id || !$this->user_can_generate_proposal($project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $bid_ids = isset($_POST['bid_ids']) ? array_map('absint', $_POST['bid_ids']) : null;
        
        $proposal_id = $this->generate_from_bids($project_id, $bid_ids);
        
        if ($proposal_id) {
            $proposal_handler = KPT_Proposal_Handler::get_instance();
            wp_send_json_success(array(
                'message' => __('Proposal generated successfully.', 'kelbe-project-tracker'),
                'proposal_id' => $proposal_id,
                'proposal' => $proposal_handler->get_proposal($proposal_id),
            ));
        } else {
            wp_send_json_error(__('Failed to generate proposal. Make sure there are accepted bids.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * Check if user can generate proposal
     *
     * @param int $project_id Project ID
     * @return bool True if user can generate, false otherwise
     */
    private function user_can_generate_proposal($project_id) {
        $user_id = get_current_user_id();
        
        // Admins can always generate
        if (current_user_can('manage_options')) {
            return true;
        }
        
        // Project author can generate
        $project = get_post($project_id);
        if ($project && $project->post_author == $user_id) {
            return true;
        }
        
        return false;
    }
}
